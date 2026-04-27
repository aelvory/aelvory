using Isopoh.Cryptography.Argon2;

namespace Aelvory.Server.Services;

public interface IPasswordHasher
{
    string Hash(string password);
    bool Verify(string password, string hash);
}

public class PasswordHasher : IPasswordHasher
{
    public string Hash(string password) => Argon2.Hash(password);
    public bool Verify(string password, string hash) => Argon2.Verify(hash, password);
}
