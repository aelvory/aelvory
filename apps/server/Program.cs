using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.RateLimiting;
using Aelvory.Server.Data;
using Aelvory.Server.HealthChecks;
using Aelvory.Server.Hubs;
using Aelvory.Server.Services;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;

JsonWebTokenHandler.DefaultMapInboundClaims = false;
System.IdentityModel.Tokens.Jwt.JwtSecurityTokenHandler.DefaultMapInboundClaims = false;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddDbContext<AelvoryDbContext>(opt =>
    opt.UseNpgsql(builder.Configuration.GetConnectionString("Postgres")));

builder.Services.AddHealthChecks()
    .AddCheck<DatabaseHealthCheck>("database", tags: ["ready"]);

builder.Services.AddSignalR()
    .AddJsonProtocol(o =>
    {
        o.PayloadSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
        o.PayloadSerializerOptions.Converters.Add(
            new JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
    });

builder.Services.AddHttpContextAccessor();

builder.Services.AddHttpClient("runner")
    .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler
    {
        AllowAutoRedirect = true,
        UseCookies = false,
        AutomaticDecompression = System.Net.DecompressionMethods.All,
    });

builder.Services.AddScoped<IPasswordHasher, PasswordHasher>();
builder.Services.AddScoped<IJwtTokenService, JwtTokenService>();
builder.Services.AddScoped<ICurrentUserService, CurrentUserService>();
builder.Services.AddScoped<IActivityLogger, ActivityLogger>();
builder.Services.AddScoped<IAccessGuard, AccessGuard>();
builder.Services.AddScoped<ISyncEntityBridge, SyncEntityBridge>();

var jwtKey = builder.Configuration["Jwt:SigningKey"]
    ?? throw new InvalidOperationException("Jwt:SigningKey missing from configuration");

// Reject the in-repo dev key in non-Development environments. The
// dev sentinel ships in appsettings.Development.json (and only
// loads when ASPNETCORE_ENVIRONMENT=Development) so a misconfigured
// production deploy that forgets to set Jwt__SigningKey would
// otherwise boot on a publicly-known key — anyone with the repo
// could mint admin tokens for that deploy. Fail loud at startup
// instead of silently running insecure.
const string DevSigningKeySentinel =
    "dev-only-signing-key-replace-me-min-32-bytes-long-please-rotate";
if (!builder.Environment.IsDevelopment())
{
    if (jwtKey == DevSigningKeySentinel)
    {
        throw new InvalidOperationException(
            "Jwt:SigningKey is the dev sentinel — refusing to start. " +
            "Set Jwt__SigningKey to a real secret (>= 32 bytes) via env var.");
    }
    if (Encoding.UTF8.GetByteCount(jwtKey) < 32)
    {
        throw new InvalidOperationException(
            "Jwt:SigningKey is too short — refusing to start. " +
            "HMAC-SHA256 needs at least 32 bytes of entropy.");
    }
}

builder.Services
    .AddAuthentication(o =>
    {
        o.DefaultAuthenticateScheme = JwtBearerDefaults.AuthenticationScheme;
        o.DefaultChallengeScheme = JwtBearerDefaults.AuthenticationScheme;
    })
    .AddJwtBearer(o =>
    {
        o.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidateAudience = true,
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true,
            ValidIssuer = builder.Configuration["Jwt:Issuer"],
            ValidAudience = builder.Configuration["Jwt:Audience"],
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtKey)),
            // Pin the algorithm explicitly. Without this, the
            // validator would accept any algorithm the library knows
            // about — making us vulnerable to "alg=none" or
            // RS256↔HS256 confusion if a future change introduces
            // an asymmetric key. Belt-and-suspenders alongside the
            // SymmetricSecurityKey type constraint.
            ValidAlgorithms = new[] { SecurityAlgorithms.HmacSha256 },
            NameClaimType = "sub",
            ClockSkew = TimeSpan.FromSeconds(30),
        };
        o.Events = new JwtBearerEvents
        {
            OnMessageReceived = ctx =>
            {
                var accessToken = ctx.Request.Query["access_token"];
                var path = ctx.HttpContext.Request.Path;
                if (!string.IsNullOrEmpty(accessToken) && path.StartsWithSegments("/hubs"))
                {
                    ctx.Token = accessToken;
                }
                return Task.CompletedTask;
            },
        };
    });

builder.Services.AddAuthorization();

// Rate limiting on auth endpoints. Without this, /auth/login is
// open to credential stuffing and /auth/refresh to refresh-token
// brute force. Per-IP fixed-window: 10 attempts per minute is
// generous for legitimate flows (sign-in, sign-up, two-device
// refresh races) and tight enough that automated dictionary
// attacks fail fast. Disabled in Development so the test suite
// (which makes hundreds of registers in a tight loop via the
// fixture) doesn't trip it.
//
// The "auth" policy is opt-in via [EnableRateLimiting("auth")]
// on AuthController so other endpoints are unaffected.
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    options.AddPolicy("auth", httpContext =>
    {
        // Only enforce in Production. Development obviously needs to
        // skip (the test factory + manual local sign-ins would trip
        // it instantly), and the "Test" environment used by the
        // integration test suite registers hundreds of accounts
        // back-to-back via TestSession.RegisterAsync — any active
        // limiter would make the suite useless.
        if (!builder.Environment.IsProduction())
        {
            return RateLimitPartition.GetNoLimiter("non-prod");
        }
        var key = httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        return RateLimitPartition.GetFixedWindowLimiter(key, _ =>
            new FixedWindowRateLimiterOptions
            {
                PermitLimit = 10,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0,
            });
    });
});

builder.Services.AddControllers()
    .AddJsonOptions(o =>
    {
        o.JsonSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
        o.JsonSerializerOptions.Converters.Add(
            new JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
    });

builder.Services.AddEndpointsApiExplorer();

builder.Services.AddOpenApiDocument(cfg =>
{
    cfg.Title = "Aelvory API";
    cfg.Version = "v1";
    cfg.DocumentName = "v1";
    cfg.AddSecurity("Bearer", [],
        new NSwag.OpenApiSecurityScheme
        {
            Type = NSwag.OpenApiSecuritySchemeType.Http,
            Scheme = "bearer",
            BearerFormat = "JWT",
            Description = "Paste JWT access token",
        });
    cfg.OperationProcessors.Add(
        new NSwag.Generation.Processors.Security.AspNetCoreOperationSecurityScopeProcessor("Bearer"));
});

builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.WithOrigins(
        "http://localhost:5173",
        "tauri://localhost",
        "https://tauri.localhost")
     .AllowAnyHeader()
     .AllowAnyMethod()
     .AllowCredentials()));

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.UseOpenApi();
    app.UseSwaggerUi();
}

// Schema bootstrap. Always-on in Development for ergonomics; opt-in
// elsewhere via `RUN_MIGRATIONS=true` so rolling restarts don't apply
// schema changes by surprise. Failures crash the process in non-Dev so
// the orchestrator surfaces it; in Dev we log + continue to keep the
// inner loop usable when migrations are mid-edit.
var runMigrations = app.Environment.IsDevelopment()
    || string.Equals(
        builder.Configuration["RUN_MIGRATIONS"],
        "true",
        StringComparison.OrdinalIgnoreCase);

if (runMigrations)
{
    await using var scope = app.Services.CreateAsyncScope();
    var db = scope.ServiceProvider.GetRequiredService<AelvoryDbContext>();
    try
    {
        app.Logger.LogInformation("Running EF Core migrations...");
        await db.Database.MigrateAsync();
        app.Logger.LogInformation("Migrations applied.");
    }
    catch (Exception ex)
    {
        app.Logger.LogError(ex, "Database migration failed on startup");
        if (!app.Environment.IsDevelopment()) throw;
    }
}

app.UseCors();
app.UseRouting();
app.UseRateLimiter();
app.UseAuthentication();
app.UseAuthorization();

// Health probes. Anonymous on purpose — these are operational, not user-
// facing API. Mapped before controllers so they're never blocked by route
// ordering or auth.
app.MapHealthChecks("/healthz/live", new HealthCheckOptions
{
    // Predicate => false: skip every registered check. Liveness only
    // proves the process is up and the request pipeline is responsive.
    Predicate = _ => false,
});
app.MapHealthChecks("/healthz/ready", new HealthCheckOptions
{
    Predicate = check => check.Tags.Contains("ready"),
});
// Default endpoint runs every check. This is what the Docker HEALTHCHECK
// hits — a failure here marks the container unhealthy and Compose's
// `depends_on: service_healthy` waits on it.
app.MapHealthChecks("/healthz");

app.MapControllers();
app.MapHub<ActivityHub>("/hubs/activity");
app.MapHub<SyncHub>("/hubs/sync");

app.Run();

/// <summary>
/// Marker for <c>WebApplicationFactory&lt;Program&gt;</c> in the test
/// project. Top-level statements compile to an internal Program class
/// by default; declaring a public partial here makes WAF's generic
/// constraint resolve to the same type without flipping the rest of
/// the assembly's visibility.
/// </summary>
public partial class Program;
