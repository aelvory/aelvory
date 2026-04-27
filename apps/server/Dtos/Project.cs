namespace Aelvory.Server.Dtos;

public record ProjectDto(
    Guid Id,
    Guid OrganizationId,
    string Name,
    string? Description,
    int Version,
    DateTime CreatedAt,
    DateTime UpdatedAt);

public record CreateProjectRequest(string Name, string? Description);

public record UpdateProjectRequest(string Name, string? Description);

public record ImportOpenApiRequest(string Spec, string? BaseEnvironmentName);

/// <summary>
/// Per-project content counts for the admin UI's project list. Numbers
/// are derived from <c>SyncEntries</c> (grouped by EntityType) — the
/// real data on the server lives there as opaque payloads, not in the
/// per-entity tables. <c>DeletedAt IS NULL</c> rows only.
///
/// Counts reflect the caller's access: a restricted Editor only gets
/// stats for projects they have grants on (the endpoint applies the
/// same filter as <c>ProjectsController.List</c>).
/// </summary>
public record ProjectStatsDto(
    Guid ProjectId,
    int CollectionCount,
    int RequestCount,
    int EnvironmentCount,
    int VariableCount);
