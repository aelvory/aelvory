namespace Aelvory.Server.Entities;

public class Project
{
    public Guid Id { get; set; }

    /// <summary>
    /// Direct parent organization. Replaces the previous Team layer
    /// (Phase 1 of the multi-tenant rework dropped Team entirely; Project
    /// is now the unit of access control).
    /// </summary>
    public Guid OrganizationId { get; set; }
    public Organization Organization { get; set; } = null!;

    public required string Name { get; set; }
    public string? Description { get; set; }
    public string? OpenApiSpec { get; set; }
    public List<ApiEnvironment> Environments { get; set; } = [];
    public List<Collection> Collections { get; set; } = [];
    public int Version { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
    public DateTime? DeletedAt { get; set; }
}
