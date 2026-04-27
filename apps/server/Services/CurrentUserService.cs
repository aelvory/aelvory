using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;

namespace Aelvory.Server.Services;

public interface ICurrentUserService
{
    Guid? UserId { get; }
    string? Email { get; }
    Guid RequireUserId();
}

public class CurrentUserService(IHttpContextAccessor accessor) : ICurrentUserService
{
    public Guid? UserId
    {
        get
        {
            var sub = accessor.HttpContext?.User.FindFirstValue(JwtRegisteredClaimNames.Sub)
                      ?? accessor.HttpContext?.User.FindFirstValue(ClaimTypes.NameIdentifier);
            return Guid.TryParse(sub, out var id) ? id : null;
        }
    }

    public string? Email =>
        accessor.HttpContext?.User.FindFirstValue(JwtRegisteredClaimNames.Email)
        ?? accessor.HttpContext?.User.FindFirstValue(ClaimTypes.Email);

    public Guid RequireUserId() =>
        UserId ?? throw new UnauthorizedAccessException("No authenticated user");
}
