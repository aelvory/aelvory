using System.Text;
using System.Text.Json;
using Aelvory.Server.Dtos;

namespace Aelvory.Server.Tests.Fixtures;

/// <summary>
/// Builders for <see cref="SyncEntryDto"/> used in tests. The desktop
/// client constructs these by walking its local SQLite — for tests we
/// hand-roll them with sensible defaults so the tests can focus on the
/// dimension being verified (scoping, conflict, cursor, etc.).
///
/// Payload shape doesn't have to match the real local row schema —
/// the server treats it as opaque bytes; only push/pull metadata
/// (orgId, projectId, entityType, entityId, updatedAt) is interpreted.
/// </summary>
public static class SyncEntries
{
    /// <summary>
    /// A "collection" entry — sits under a project. Use for tests
    /// that need a project-scoped row (the most common case).
    /// </summary>
    public static SyncEntryDto NewCollection(
        Guid orgId,
        Guid projectId,
        Guid? entityId = null,
        DateTime? updatedAt = null)
    {
        return new SyncEntryDto(
            OrganizationId: orgId,
            ProjectId: projectId,
            EntityType: "collections",
            EntityId: entityId ?? Guid.NewGuid(),
            PayloadFormat: "plain",
            Payload: PlaintextJson(new { name = "Test collection" }),
            CryptoHeader: null,
            UpdatedAt: updatedAt ?? DateTime.UtcNow,
            DeletedAt: null,
            // Push side ignores the client's Seq — server assigns its
            // own from a per-org max+1. 0 here is fine; tests asserting
            // on Seq read it from the server's response.
            Seq: 0);
    }

    /// <summary>
    /// An org-level entry (no project scope). The server treats
    /// ProjectId=null as "visible to every member of the org",
    /// including restricted Editors.
    /// </summary>
    public static SyncEntryDto NewMember(
        Guid orgId,
        Guid? entityId = null,
        DateTime? updatedAt = null)
    {
        return new SyncEntryDto(
            OrganizationId: orgId,
            ProjectId: null,
            EntityType: "members",
            EntityId: entityId ?? Guid.NewGuid(),
            PayloadFormat: "plain",
            Payload: PlaintextJson(new { role = "editor" }),
            CryptoHeader: null,
            UpdatedAt: updatedAt ?? DateTime.UtcNow,
            DeletedAt: null,
            Seq: 0);
    }

    /// <summary>
    /// A request entry under a collection. Useful for batch-shape
    /// tests that want a few different entity types in one push.
    /// </summary>
    public static SyncEntryDto NewRequest(
        Guid orgId,
        Guid projectId,
        Guid? entityId = null,
        DateTime? updatedAt = null)
    {
        return new SyncEntryDto(
            OrganizationId: orgId,
            ProjectId: projectId,
            EntityType: "requests",
            EntityId: entityId ?? Guid.NewGuid(),
            PayloadFormat: "plain",
            Payload: PlaintextJson(new { method = "GET", url = "/healthz" }),
            CryptoHeader: null,
            UpdatedAt: updatedAt ?? DateTime.UtcNow,
            DeletedAt: null,
            Seq: 0);
    }

    private static byte[] PlaintextJson(object value) =>
        Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value));
}
