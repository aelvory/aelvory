namespace Aelvory.Server.Entities;

public enum VariableScope
{
    Global,
    Organization,
    Team,
    Project,
    Environment,
    Request,
    Collection
}

public class Variable
{
    public Guid Id { get; set; }
    public VariableScope Scope { get; set; }
    public Guid ScopeId { get; set; }
    public required string Key { get; set; }
    public string? Value { get; set; }
    public bool IsSecret { get; set; }
    public byte[]? Ciphertext { get; set; }
    public byte[]? Nonce { get; set; }
    public Guid? KeyId { get; set; }
    public int Version { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}
