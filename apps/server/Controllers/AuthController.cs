using System.Security.Cryptography;
using System.Text;
using Aelvory.Server.Data;
using Aelvory.Server.Dtos;
using Aelvory.Server.Entities;
using Aelvory.Server.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;

namespace Aelvory.Server.Controllers;

/// <summary>
/// SHA-256 hash a refresh token for storage. The raw token is 64
/// random bytes (~512 bits of entropy) so a fast unkeyed hash is
/// sufficient — we just need "DB read can't recover the token."
/// Hex-encoded so the column is human-readable in DB tooling.
/// </summary>
internal static class RefreshTokenHasher
{
    public static string Hash(string raw)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(raw));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }
}

[ApiController]
[Route("api/auth")]
[EnableRateLimiting("auth")]
public class AuthController(
    AelvoryDbContext db,
    IPasswordHasher hasher,
    IJwtTokenService jwt,
    ICurrentUserService current) : ControllerBase
{
    [HttpPost("register")]
    public async Task<ActionResult<TokenResponse>> Register(
        [FromBody] RegisterRequest req,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(req.Email) || string.IsNullOrWhiteSpace(req.Password))
            return BadRequest(new { error = "invalid_input" });

        if (await db.Users.AnyAsync(u => u.Email == req.Email, ct))
            return Conflict(new { error = "email_taken" });

        var now = DateTime.UtcNow;
        var user = new User
        {
            Id = Guid.NewGuid(),
            Email = req.Email,
            DisplayName = req.DisplayName,
            PasswordHash = hasher.Hash(req.Password),
            CreatedAt = now,
            UpdatedAt = now,
        };

        var personalOrg = new Organization
        {
            Id = Guid.NewGuid(),
            Name = $"{req.DisplayName}'s workspace",
            Kind = OrganizationKind.Personal,
            OwnerId = user.Id,
            CreatedAt = now,
            UpdatedAt = now,
        };

        var owner = new Member
        {
            Id = Guid.NewGuid(),
            OrganizationId = personalOrg.Id,
            UserId = user.Id,
            Role = MemberRole.Owner,
            CreatedAt = now,
        };

        db.Users.Add(user);
        db.Organizations.Add(personalOrg);
        db.Members.Add(owner);
        await db.SaveChangesAsync(ct);

        return await IssueTokensAsync(user, ct);
    }

    [HttpPost("login")]
    public async Task<ActionResult<TokenResponse>> Login(
        [FromBody] LoginRequest req,
        CancellationToken ct)
    {
        var user = await db.Users.SingleOrDefaultAsync(u => u.Email == req.Email, ct);
        if (user is null || user.PasswordHash is null || !hasher.Verify(req.Password, user.PasswordHash))
            return Unauthorized(new { error = "invalid_credentials" });

        return await IssueTokensAsync(user, ct);
    }

    [HttpPost("refresh")]
    public async Task<ActionResult<TokenResponse>> Refresh(
        [FromBody] RefreshRequest req,
        CancellationToken ct)
    {
        // Look up by hash, not by raw token. Plaintext is never
        // queryable post-migration so a DB compromise can't replay
        // sessions, and the hash lookup is just as fast (indexed).
        var hash = RefreshTokenHasher.Hash(req.RefreshToken);
        var now = DateTime.UtcNow;
        var token = await db.RefreshTokens
            .Include(t => t.User)
            .SingleOrDefaultAsync(
                t => t.TokenHash == hash && t.ExpiresAt > now && t.RevokedAt == null,
                ct);

        if (token is null)
            return Unauthorized(new { error = "invalid_refresh" });

        token.RevokedAt = now;
        return await IssueTokensAsync(token.User, ct);
    }

    [Authorize]
    [HttpPost("logout")]
    public async Task<IActionResult> Logout([FromBody] RefreshRequest req, CancellationToken ct)
    {
        // Bind the lookup to the calling user's id. Without this,
        // any authenticated user could submit any refresh-token
        // string and revoke it (random Guess space is huge so the
        // practical impact is low, but the API shouldn't allow
        // foreign-token revocation by design).
        var userId = current.RequireUserId();
        var hash = RefreshTokenHasher.Hash(req.RefreshToken);
        var token = await db.RefreshTokens
            .SingleOrDefaultAsync(t => t.TokenHash == hash && t.UserId == userId, ct);
        if (token is not null)
        {
            token.RevokedAt = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
        }
        return NoContent();
    }

    [Authorize]
    [HttpGet("me")]
    public async Task<ActionResult<UserDto>> Me(CancellationToken ct)
    {
        var userId = current.RequireUserId();
        var user = await db.Users.FindAsync([userId], ct);
        if (user is null) return NotFound();
        return ToDto(user);
    }

    [Authorize]
    [HttpPost("me/public-key")]
    public async Task<ActionResult<UserDto>> SetPublicKey(
        [FromBody] SetPublicKeyRequest req,
        CancellationToken ct)
    {
        var userId = current.RequireUserId();
        var user = await db.Users.FindAsync([userId], ct);
        if (user is null) return NotFound();

        user.PublicKey = Convert.FromBase64String(req.PublicKey);
        user.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        return ToDto(user);
    }

    private async Task<TokenResponse> IssueTokensAsync(User user, CancellationToken ct)
    {
        // Generate the raw token, hand it back to the client in the
        // response, but only persist its SHA-256 hash. The raw value
        // never lives in the DB.
        var refresh = jwt.GenerateRefreshToken();
        db.RefreshTokens.Add(new RefreshToken
        {
            Id = Guid.NewGuid(),
            UserId = user.Id,
            TokenHash = RefreshTokenHasher.Hash(refresh),
            ExpiresAt = DateTime.UtcNow.AddDays(30),
            CreatedAt = DateTime.UtcNow,
        });
        await db.SaveChangesAsync(ct);

        return new TokenResponse(
            jwt.IssueAccessToken(user),
            refresh,
            jwt.AccessTokenLifetimeSeconds);
    }

    private static UserDto ToDto(User u) =>
        new(u.Id, u.Email, u.DisplayName,
            u.PublicKey is null ? null : Convert.ToBase64String(u.PublicKey));
}
