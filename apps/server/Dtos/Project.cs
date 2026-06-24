namespace Aelvory.Server.Dtos;

public record ProjectDto(
    Guid Id,
    Guid OrganizationId,
    string Name,
    string? Description,
    int Version,
    DateTime CreatedAt,
    DateTime UpdatedAt);

/// <summary>
/// Project row for the admin UI's list, sourced from <c>SyncEntries</c>
/// (entityType "projects") rather than the canonical <c>Projects</c>
/// table. This is what makes desktop-created projects — which only ever
/// reach the server as sync entries, never as <c>Projects</c> rows —
/// visible in the admin.
///
/// <para><c>Name</c>/<c>Description</c> are nullable because an
/// end-to-end-encrypted payload is opaque to the server: we know the
/// project exists (the envelope is plaintext) but can't read its name.
/// Such rows come back with <c>Encrypted = true</c>.</para>
///
/// <para><c>Manageable</c> is true only when a canonical <c>Projects</c>
/// row also exists. The write paths (edit/delete/grant) still anchor on
/// that table, so desktop-origin projects are view-only in the admin for
/// now.</para>
/// </summary>
public record AdminProjectDto(
    Guid Id,
    Guid OrganizationId,
    string? Name,
    string? Description,
    int Version,
    DateTime CreatedAt,
    DateTime UpdatedAt,
    bool Encrypted,
    bool Manageable);

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
