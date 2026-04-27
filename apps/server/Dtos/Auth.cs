namespace Aelvory.Server.Dtos;

public record RegisterRequest(string Email, string Password, string DisplayName);

public record LoginRequest(string Email, string Password);

public record RefreshRequest(string RefreshToken);

public record TokenResponse(string AccessToken, string RefreshToken, int ExpiresIn);

public record UserDto(Guid Id, string Email, string DisplayName, string? PublicKey);

public record SetPublicKeyRequest(string PublicKey);
