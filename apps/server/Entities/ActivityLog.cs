namespace Aelvory.Server.Entities;

public class ActivityLog
{
    public Guid Id { get; set; }
    public Guid ActorId { get; set; }
    public User Actor { get; set; } = null!;
    public Guid OrganizationId { get; set; }
    public Organization Organization { get; set; } = null!;
    public required string EntityType { get; set; }
    public Guid EntityId { get; set; }
    public required string Action { get; set; }
    public string MetadataJson { get; set; } = "{}";
    public DateTime Timestamp { get; set; }
}
