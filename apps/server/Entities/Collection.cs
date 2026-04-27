namespace Aelvory.Server.Entities;

public class Collection
{
    public Guid Id { get; set; }
    public Guid ProjectId { get; set; }
    public Project Project { get; set; } = null!;
    public Guid? ParentId { get; set; }
    public required string Name { get; set; }
    public int SortIndex { get; set; }
    public string? AuthJson { get; set; }
    public List<ApiRequest> Requests { get; set; } = [];
    public int Version { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
    public DateTime? DeletedAt { get; set; }
}
