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

    /// <summary>
    /// A "projects" entry — how a desktop-created project reaches the
    /// server (it never hits the canonical Projects table). The payload
    /// mirrors the desktop's local `projects` row so the admin
    /// `projects/all` endpoint can read its name. For a projects entry
    /// the project id IS the entity id and the project scope.
    /// </summary>
    public static SyncEntryDto NewProject(
        Guid orgId,
        Guid? projectId = null,
        string name = "Desktop project",
        string? description = null,
        DateTime? updatedAt = null)
    {
        var id = projectId ?? Guid.NewGuid();
        var now = updatedAt ?? DateTime.UtcNow;
        return new SyncEntryDto(
            OrganizationId: orgId,
            ProjectId: id,
            EntityType: "projects",
            EntityId: id,
            PayloadFormat: "plain",
            Payload: PlaintextJson(new
            {
                id,
                organizationId = orgId,
                name,
                description,
                version = 1,
                createdAt = now,
                updatedAt = now,
                deletedAt = (DateTime?)null,
            }),
            CryptoHeader: null,
            UpdatedAt: now,
            DeletedAt: null,
            Seq: 0);
    }

    /// <summary>
    /// A projects entry with an E2EE-encrypted payload — the server can't
    /// read its name, only confirm it exists. Mirrors what a desktop with
    /// E2EE enabled pushes.
    /// </summary>
    public static SyncEntryDto NewEncryptedProject(
        Guid orgId,
        Guid? projectId = null,
        DateTime? updatedAt = null)
    {
        var id = projectId ?? Guid.NewGuid();
        var now = updatedAt ?? DateTime.UtcNow;
        return new SyncEntryDto(
            OrganizationId: orgId,
            ProjectId: id,
            EntityType: "projects",
            EntityId: id,
            PayloadFormat: "encrypted",
            Payload: Encoding.UTF8.GetBytes("opaque-ciphertext-bytes"),
            CryptoHeader: "{\"alg\":\"xchacha20poly1305\",\"kdf\":\"argon2id\"}",
            UpdatedAt: now,
            DeletedAt: null,
            Seq: 0);
    }

    private static byte[] PlaintextJson(object value) =>
        Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value));
}
