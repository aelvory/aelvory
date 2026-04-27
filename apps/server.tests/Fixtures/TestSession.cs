using Aelvory.Server.Dtos;
using Aelvory.Server.Entities;

namespace Aelvory.Server.Tests.Fixtures;

/// <summary>
/// Convenience layer over <see cref="ApiClient"/> for the very common
/// "register a user, capture their tokens, return a typed handle"
/// pattern. Every test that exercises auth-gated behaviour starts
/// with one of these.
///
/// A session knows its email/userId and carries an authenticated
/// <see cref="ApiClient"/> ready for further calls. Multiple sessions
/// in the same test (User A invites User B, etc.) just use multiple
/// <see cref="HttpClient"/> instances against the same factory — the
/// factory is shared but each <see cref="HttpClient"/> has its own
/// auth state.
/// </summary>
public sealed class TestSession
{
    public required string Email { get; init; }
    public required string DisplayName { get; init; }
    public required Guid UserId { get; init; }
    public required string AccessToken { get; init; }
    public required string RefreshToken { get; init; }
    /// <summary>
    /// API client preconfigured with this session's bearer token.
    /// Use <see cref="Sessions.NewClient"/> on the factory if you
    /// need an unauthenticated client instead.
    /// </summary>
    public required ApiClient Api { get; init; }

    /// <summary>
    /// Fetch the user's personal organization (created at register
    /// time). Cached on first call; subsequent calls are local.
    /// </summary>
    public async Task<Guid> PersonalOrgIdAsync()
    {
        _personalOrgId ??= await ResolvePersonalOrgIdAsync();
        return _personalOrgId.Value;
    }
    private Guid? _personalOrgId;

    private async Task<Guid> ResolvePersonalOrgIdAsync()
    {
        var orgs = await Api.GetAsync<List<OrganizationDto>>("/api/organizations");
        // Registration creates exactly one personal org named
        // "{displayName}'s workspace" (see AuthController.Register).
        // We match on Kind because the DisplayName is owned by the
        // user — they could rename their workspace later in a future
        // feature, and we don't want a brittle string match here.
        var personal = orgs.FirstOrDefault(o => o.Kind == OrganizationKind.Personal)
            ?? throw new InvalidOperationException(
                "Expected a personal org from /api/organizations after register");
        return personal.Id;
    }
}

/// <summary>
/// Helpers attached to <see cref="AelvoryFactory"/> for spinning up
/// test users. Lives outside the factory so each test class can
/// extend / wrap them without subclassing the factory.
/// </summary>
public static class Sessions
{
    public static ApiClient NewClient(this AelvoryFactory factory) =>
        new(factory.CreateClient());

    /// <summary>
    /// Register a fresh user, capture their tokens, return a session
    /// with an authenticated <see cref="ApiClient"/>. The email is
    /// suffixed with a guid so multiple calls in the same test don't
    /// collide on the unique-email constraint.
    /// </summary>
    public static async Task<TestSession> RegisterAsync(
        this AelvoryFactory factory,
        string displayName = "Test User",
        string password = "P@ssw0rd!1")
    {
        var email = $"user-{Guid.NewGuid():N}@aelvory.test";
        var api = factory.NewClient();
        var tokens = await api.PostAsync<TokenResponse>("/api/auth/register",
            new RegisterRequest(email, password, displayName));
        api.Token = tokens.AccessToken;

        var me = await api.GetAsync<UserDto>("/api/auth/me");
        return new TestSession
        {
            Email = email,
            DisplayName = displayName,
            UserId = me.Id,
            AccessToken = tokens.AccessToken,
            RefreshToken = tokens.RefreshToken,
            Api = api,
        };
    }

    /// <summary>
    /// Already-registered version: just login. Used when a test
    /// explicitly exercises the login path or wants to start from
    /// an existing email.
    /// </summary>
    public static async Task<TestSession> LoginAsync(
        this AelvoryFactory factory,
        string email,
        string password,
        string displayName = "Test User")
    {
        var api = factory.NewClient();
        var tokens = await api.PostAsync<TokenResponse>("/api/auth/login",
            new LoginRequest(email, password));
        api.Token = tokens.AccessToken;
        var me = await api.GetAsync<UserDto>("/api/auth/me");
        return new TestSession
        {
            Email = email,
            DisplayName = displayName,
            UserId = me.Id,
            AccessToken = tokens.AccessToken,
            RefreshToken = tokens.RefreshToken,
            Api = api,
        };
    }
}
