using System.Net;
using Aelvory.Server.Dtos;
using Aelvory.Server.Tests.Fixtures;
using Xunit;

namespace Aelvory.Server.Tests.Auth;

/// <summary>
/// End-to-end auth happy/sad paths. Covers the most common regression
/// surfaces: hash/verify round-trip, JWT issue/parse, refresh-token
/// rotation, /me round-trip.
/// </summary>
[Collection("postgres")]
public sealed class RegisterLoginTests : IClassFixture<AelvoryFactory>, IAsyncLifetime
{
    private readonly AelvoryFactory _factory;
    public RegisterLoginTests(AelvoryFactory factory) { _factory = factory; }

    // xUnit creates a new instance of the test class per test method,
    // so InitializeAsync runs before each [Fact]. Resetting the DB
    // here keeps tests isolated without paying the cost of a fresh
    // host/migration cycle.
    public Task InitializeAsync() => _factory.ResetAsync();
    public Task DisposeAsync() => Task.CompletedTask;

    [Fact]
    public async Task Register_returns_tokens_and_creates_personal_org()
    {
        var sess = await _factory.RegisterAsync(displayName: "Alice");

        Assert.NotEmpty(sess.AccessToken);
        Assert.NotEmpty(sess.RefreshToken);

        var orgs = await sess.Api.GetAsync<List<OrganizationDto>>("/api/organizations");
        // Registration must auto-create a personal org so a fresh
        // user lands somewhere usable. If this regresses, the desktop
        // sign-in flow's reconciliation has nothing to anchor to.
        Assert.Single(orgs);
        Assert.Equal(Server.Entities.OrganizationKind.Personal, orgs[0].Kind);
        Assert.Equal(sess.UserId, orgs[0].OwnerId);
    }

    [Fact]
    public async Task Register_with_duplicate_email_returns_409()
    {
        var sess = await _factory.RegisterAsync();
        var api = _factory.NewClient();

        var res = await api.PostRawAsync("/api/auth/register",
            new RegisterRequest(sess.Email, "AnotherP@ss!1", "Other"));

        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
    }

    [Fact]
    public async Task Login_with_correct_password_succeeds()
    {
        var first = await _factory.RegisterAsync(password: "Bob's-Pa$$w0rd");
        var second = await _factory.LoginAsync(first.Email, "Bob's-Pa$$w0rd");

        Assert.Equal(first.UserId, second.UserId);
        // Tokens should be fresh — refresh tokens are per-issuance, so
        // two logins yield two distinct refresh tokens even for the
        // same user.
        Assert.NotEqual(first.RefreshToken, second.RefreshToken);
    }

    [Fact]
    public async Task Login_with_wrong_password_returns_401()
    {
        var sess = await _factory.RegisterAsync(password: "Right1!");
        var api = _factory.NewClient();

        var res = await api.PostRawAsync("/api/auth/login",
            new LoginRequest(sess.Email, "Wrong2!"));

        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    [Fact]
    public async Task Login_for_unknown_email_returns_401()
    {
        var api = _factory.NewClient();
        var res = await api.PostRawAsync("/api/auth/login",
            new LoginRequest("nobody@aelvory.test", "Whatever1!"));

        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    [Fact]
    public async Task Refresh_rotates_tokens_and_keeps_user_id()
    {
        var sess = await _factory.RegisterAsync();
        var api = _factory.NewClient();
        var refreshed = await api.PostAsync<TokenResponse>("/api/auth/refresh",
            new RefreshRequest(sess.RefreshToken));

        // New tokens are issued — including a new refresh (single-use
        // semantics on the original).
        Assert.NotEqual(sess.AccessToken, refreshed.AccessToken);
        Assert.NotEqual(sess.RefreshToken, refreshed.RefreshToken);

        // The new access token should authenticate the same user.
        api.Token = refreshed.AccessToken;
        var me = await api.GetAsync<UserDto>("/api/auth/me");
        Assert.Equal(sess.UserId, me.Id);
    }

    [Fact]
    public async Task Refresh_with_already_used_token_returns_401()
    {
        var sess = await _factory.RegisterAsync();
        var api = _factory.NewClient();

        // Use the refresh once …
        _ = await api.PostAsync<TokenResponse>("/api/auth/refresh",
            new RefreshRequest(sess.RefreshToken));
        // … then try to use it again. The first use revoked it.
        var res = await api.PostRawAsync("/api/auth/refresh",
            new RefreshRequest(sess.RefreshToken));

        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    [Fact]
    public async Task Me_without_token_returns_401()
    {
        var api = _factory.NewClient();
        var res = await api.GetRawAsync("/api/auth/me");
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }
}
