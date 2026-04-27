using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Aelvory.Server.Entities;
using Microsoft.IdentityModel.Tokens;

namespace Aelvory.Server.Services;

public interface IJwtTokenService
{
    string IssueAccessToken(User user);
    string GenerateRefreshToken();
    int AccessTokenLifetimeSeconds { get; }
}

public class JwtTokenService(IConfiguration config) : IJwtTokenService
{
    public int AccessTokenLifetimeSeconds =>
        config.GetValue("Jwt:AccessTokenMinutes", 15) * 60;

    private string GetKey() =>
        config["Jwt:SigningKey"]
        ?? throw new InvalidOperationException("Jwt:SigningKey missing");

    public string IssueAccessToken(User user)
    {
        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(GetKey()));
        var creds = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);

        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, user.Id.ToString()),
            new(JwtRegisteredClaimNames.Email, user.Email),
            new(JwtRegisteredClaimNames.Name, user.DisplayName),
            new(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString()),
        };

        var token = new JwtSecurityToken(
            issuer: config["Jwt:Issuer"],
            audience: config["Jwt:Audience"],
            claims: claims,
            expires: DateTime.UtcNow.AddSeconds(AccessTokenLifetimeSeconds),
            signingCredentials: creds);

        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    public string GenerateRefreshToken()
    {
        var bytes = new byte[64];
        RandomNumberGenerator.Fill(bytes);
        return Convert.ToBase64String(bytes);
    }
}
