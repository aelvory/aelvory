namespace Aelvory.Server.Entities;

public enum ScriptPhase
{
    Pre,
    Post,
    Test
}

public class Script
{
    public Guid Id { get; set; }
    public Guid RequestId { get; set; }
    public ApiRequest Request { get; set; } = null!;
    public ScriptPhase Phase { get; set; }
    public required string Source { get; set; }
    public int Version { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}
