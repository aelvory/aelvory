using System.Net;
using Aelvory.Server.Data;
using Aelvory.Server.Dtos;
using Aelvory.Server.Tests.Fixtures;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace Aelvory.Server.Tests.Auth;

/// <summary>
/// Regression tests for security hardening — each pins a specific
/// invariant from the security audit so a future refactor can't
/// silently undo the fix.
/// </summary>
[Collection("postgres")]
public sealed class SecurityHardeningTests : IClassFixture<AelvoryFactory>, IAsyncLifetime
{
    private readonly AelvoryFactory _factory;
    public SecurityHardeningTests(AelvoryFactory factory) { _factory = factory; }
    public Task InitializeAsync() => _factory.ResetAsync();
    public Task DisposeAsync() => Task.CompletedTask;

    [Fact]
    public async Task Refresh_token_is_stored_hashed_not_plaintext()
    {
        // Register issues a refresh token; its plaintext should never
        // appear in the DB. We assert that no row in RefreshTokens
        // has a TokenHash equal to the plaintext (which is what a
        // regression to plaintext storage would produce). The hash
        // is hex-encoded SHA-256 — the plaintext is base64 of 64
        // random bytes, structurally distinct so a sloppy
        // regression couldn't accidentally still pass.
        var sess = await _factory.RegisterAsync();

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AelvoryDbContext>();
        var rows = await db.RefreshTokens
            .Where(r => r.UserId == sess.UserId)
            .ToListAsync();
        var row = Assert.Single(rows);

        Assert.NotEqual(sess.RefreshToken, row.TokenHash);
        // Hex-encoded SHA-256 of any input is exactly 64 characters
        // of [0-9a-f]. Stricter than length alone — guards against
        // someone storing base64 or some other "obviously not
        // plaintext but still recoverable" representation.
        Assert.Equal(64, row.TokenHash.Length);
        Assert.Matches("^[0-9a-f]+$", row.TokenHash);
    }

    [Fact]
    public async Task Refresh_works_after_hashed_storage()
    {
        // End-to-end smoke test: issue → refresh succeeds. Catches
        // a regression where, say, the issue path hashes one way
        // and the refresh path hashes another (or doesn't hash at
        // all), which would silently make every refresh fail.
        var sess = await _factory.RegisterAsync();
        var api = _factory.NewClient();
        var refreshed = await api.PostAsync<TokenResponse>(
            "/api/auth/refresh",
            new RefreshRequest(sess.RefreshToken));
        Assert.NotEqual(sess.AccessToken, refreshed.AccessToken);
        Assert.NotEqual(sess.RefreshToken, refreshed.RefreshToken);
    }

    [Fact]
    public async Task Logout_cannot_revoke_another_users_refresh_token()
    {
        // Bug being pinned: pre-fix Logout queried RefreshTokens by
        // token string only, with no UserId binding. Any
        // authenticated user could submit any refresh-token string
        // and revoke it. Random Guess space is huge so unexploitable
        // in practice but the API shouldn't allow foreign-token
        // revocation by design.
        var alice = await _factory.RegisterAsync();
        var bob = await _factory.RegisterAsync();

        // Alice tries to revoke Bob's refresh token using her own
        // access token. Logout returns NoContent regardless of
        // whether anything was revoked (intentional — leaking the
        // existence of a token via 200/404 is its own oracle), but
        // the underlying refresh token should be untouched.
        var res = await alice.Api.PostRawAsync(
            "/api/auth/logout",
            new RefreshRequest(bob.RefreshToken));
        Assert.Equal(HttpStatusCode.NoContent, res.StatusCode);

        // Bob's refresh still works → Alice didn't revoke it.
        var bobApi = _factory.NewClient();
        var refreshed = await bobApi.PostAsync<TokenResponse>(
            "/api/auth/refresh",
            new RefreshRequest(bob.RefreshToken));
        Assert.NotEqual(bob.AccessToken, refreshed.AccessToken);
    }

    [Fact]
    public async Task Logout_revokes_callers_own_refresh_token()
    {
        // Same fix, opposite direction: caller-bound logout MUST
        // still work for the caller's own token. Otherwise we'd
        // have soft-broken logout in fixing the foreign-revoke gap.
        var sess = await _factory.RegisterAsync();
        await sess.Api.PostRawAsync(
            "/api/auth/logout",
            new RefreshRequest(sess.RefreshToken));

        // The just-revoked token should no longer refresh.
        var api = _factory.NewClient();
        var res = await api.PostRawAsync(
            "/api/auth/refresh",
            new RefreshRequest(sess.RefreshToken));
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    [Fact]
    public async Task ListMembers_of_foreign_org_returns_NotFound_consistently_with_Get()
    {
        // Pre-fix: Get returned 404, ListMembers returned 403.
        // Inconsistency = oracle for "this org id exists, you just
        // can't see it." Both endpoints should behave identically
        // to a probing non-member.
        var alice = await _factory.RegisterAsync();
        var bob = await _factory.RegisterAsync();
        var bobOrgId = await bob.PersonalOrgIdAsync();

        var getRes = await alice.Api.GetRawAsync($"/api/organizations/{bobOrgId}");
        var membersRes = await alice.Api.GetRawAsync(
            $"/api/organizations/{bobOrgId}/members");

        Assert.Equal(getRes.StatusCode, membersRes.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, membersRes.StatusCode);
    }
}
