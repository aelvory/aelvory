namespace Aelvory.Server.Entities;

public enum OrganizationKind
{
    Personal,
    Team
}

/// <summary>
/// Roles a user can hold inside an organization. The earlier "Viewer"
/// role was dropped — read-only access turned out to make collaboration
/// confusing (people couldn't run requests without a write role) and
/// the per-project ProjectMembers grant in Phase 2 makes "see-only-some-
/// projects" the better way to restrict access.
/// </summary>
public enum MemberRole
{
    Owner,
    Admin,
    Editor,
}

public class Organization
{
    public Guid Id { get; set; }
    public required string Name { get; set; }
    public OrganizationKind Kind { get; set; }
    public Guid OwnerId { get; set; }
    public User Owner { get; set; } = null!;
    public List<Member> Members { get; set; } = [];

    /// <summary>
    /// Direct children — Project replaces the dropped Team layer.
    /// </summary>
    public List<Project> Projects { get; set; } = [];

    public int Version { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
    public DateTime? DeletedAt { get; set; }
}

public class Member
{
    public Guid Id { get; set; }
    public Guid OrganizationId { get; set; }
    public Organization Organization { get; set; } = null!;
    public Guid UserId { get; set; }
    public User User { get; set; } = null!;
    public MemberRole Role { get; set; }

    /// <summary>
    /// When true, this member only has access to the projects listed in
    /// <c>ProjectMembers</c>. When false (default), they see every project
    /// in the organization. Owners and admins are implicitly unrestricted.
    /// Phase 2 enforces this in the sync controller; Phase 1 just wires
    /// the column.
    /// </summary>
    public bool Restricted { get; set; }

    public byte[]? WrappedDek { get; set; }
    public DateTime CreatedAt { get; set; }
}

/// <summary>
/// Per-project access grant for restricted members. Implies editor-level
/// access on the named project. Org owners and admins don't need rows
/// here — they always see everything.
/// </summary>
public class ProjectMember
{
    public Guid Id { get; set; }
    public Guid ProjectId { get; set; }
    public Project Project { get; set; } = null!;
    public Guid UserId { get; set; }
    public User User { get; set; } = null!;
    public Guid GrantedBy { get; set; }
    public DateTime GrantedAt { get; set; }
}
