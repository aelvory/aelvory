using Aelvory.Server.Data;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Npgsql;
using Xunit;

namespace Aelvory.Server.Tests.Fixtures;

/// <summary>
/// One <see cref="WebApplicationFactory{TEntryPoint}"/> per test class.
/// Each instance owns a freshly-created Postgres database on the
/// shared container — created in <see cref="InitializeAsync"/>, dropped
/// in <see cref="DisposeAsync"/>. Tests inside a class can call
/// <see cref="ResetAsync"/> to wipe data tables back to empty.
///
/// Why per-class DBs instead of one shared DB with per-test resets:
/// xUnit can run distinct test classes in parallel (default behaviour),
/// so they MUST NOT share a database — TRUNCATE in one would clobber
/// state another is mid-assert against. Per-class isolation is the
/// cheapest way to keep that parallelism without elaborate locking.
///
/// Migrations vs <see cref="DatabaseFacade.EnsureCreatedAsync"/>: we
/// run real migrations (<c>MigrateAsync</c>) so the schema matches
/// production — including the multi-tenant migration's index/constraint
/// shape. EnsureCreated would skip migrations and build from the model,
/// which silently diverges over time.
/// </summary>
public sealed class AelvoryFactory : WebApplicationFactory<Program>, IAsyncLifetime
{
    private readonly PostgresFixture _postgres;
    private readonly string _dbName;

    public AelvoryFactory(PostgresFixture postgres)
    {
        _postgres = postgres;
        // 16-char suffix is comfortably unique across a single test
        // run and keeps the db name short enough to stay under
        // Postgres' 63-char identifier limit.
        _dbName = "aelvory_test_" + Guid.NewGuid().ToString("N")[..16];
    }

    public string ConnectionString =>
        _postgres.ConnectionStringTemplate.Replace("{DB}", _dbName);

    public async Task InitializeAsync()
    {
        await using var admin = new NpgsqlConnection(_postgres.AdminConnectionString);
        await admin.OpenAsync();
        await using var cmd = admin.CreateCommand();
        // Identifier is constructed locally from a guid, not user
        // input — string interpolation is safe here. Quoting it just
        // in case Postgres ever objects to mixed case in a future
        // identifier rev.
        cmd.CommandText = $"CREATE DATABASE \"{_dbName}\"";
        await cmd.ExecuteNonQueryAsync();

        // Trigger WAF host build so MigrateAsync runs the same path
        // production does. Calling Services touches the singleton
        // host — first call lazily wires everything up.
        using var scope = Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AelvoryDbContext>();
        await db.Database.MigrateAsync();
    }

    public new async Task DisposeAsync()
    {
        // Tear down the host first so EF / Npgsql release any pooled
        // connections to the about-to-be-dropped DB. Without this,
        // DROP DATABASE fails with "is being accessed by other users".
        await base.DisposeAsync();
        NpgsqlConnection.ClearAllPools();

        await using var admin = new NpgsqlConnection(_postgres.AdminConnectionString);
        await admin.OpenAsync();
        await using var cmd = admin.CreateCommand();
        cmd.CommandText = $"DROP DATABASE IF EXISTS \"{_dbName}\" WITH (FORCE)";
        await cmd.ExecuteNonQueryAsync();
    }

    /// <summary>
    /// Wipe every row from every user-data table. Schema stays.
    /// Cheap-enough to call between tests, in the order of tens of
    /// milliseconds on an idle Postgres. Tables are listed in
    /// child-before-parent order so even if FKs ever flip to
    /// <c>RESTRICT</c> we won't break.
    /// </summary>
    public async Task ResetAsync()
    {
        // RESTART IDENTITY zeroes any sequences (notably
        // SyncEntries.Seq); CASCADE rides over FK relationships so we
        // don't have to micro-manage the order. One round-trip.
        await using var conn = new NpgsqlConnection(ConnectionString);
        await conn.OpenAsync();
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            TRUNCATE TABLE
                "ActivityLogs",
                "ProjectMembers",
                "Members",
                "Projects",
                "Organizations",
                "RefreshTokens",
                "Users",
                "SyncEntries"
            RESTART IDENTITY CASCADE
        """;
        await cmd.ExecuteNonQueryAsync();
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Test");

        // Postgres connection is per-test-class (each class has its own
        // database on the shared container) so it's pushed via the
        // in-memory provider here. The Jwt:* values are set as
        // process-wide env vars by `TestBootstrap` (ModuleInitializer)
        // so they're visible when Program.cs reads `Jwt:SigningKey`
        // eagerly at top-level — before this callback fires. See
        // TestBootstrap.cs for the full rationale.
        builder.ConfigureAppConfiguration((_, cfg) =>
        {
            cfg.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ConnectionStrings:Postgres"] = ConnectionString,
            });
        });

        builder.ConfigureServices(services =>
        {
            // Replace the DbContext registration with one pointing at
            // our per-class database. Program.cs registers it from
            // ConnectionStrings:Postgres, so the config override above
            // already does the right thing — but if anything in the
            // server picks up the old config later, this is a belt
            // alongside the suspenders.
            services.RemoveAll<DbContextOptions<AelvoryDbContext>>();
            services.AddDbContext<AelvoryDbContext>(opt =>
                opt.UseNpgsql(ConnectionString));
        });
    }
}
