namespace Aelvory.Server.Entities;

public class SyncEntry
{
    public Guid Id { get; set; }

    /// <summary>
    /// The user who pushed this version of the row. With multi-tenant
    /// sync, this is "the writer" — not the row's owner. Anyone with
    /// access to <see cref="OrganizationId"/> (and <see cref="ProjectId"/>
    /// when set) can pull the row regardless of who wrote it.
    /// </summary>
    public Guid UserId { get; set; }
    public User User { get; set; } = null!;

    /// <summary>
    /// Organization the row belongs to. Always set — this is the top-level
    /// access boundary. The push handler derives it from the entity
    /// hierarchy (Project → Organization, Collection → Project →
    /// Organization, etc.) and rejects any attempt to push under an org
    /// the user isn't a member of.
    /// </summary>
    public Guid OrganizationId { get; set; }
    public Organization Organization { get; set; } = null!;

    /// <summary>
    /// Project the row belongs to, or null for org-level entities
    /// (organizations themselves, members, project_members). When set,
    /// only users with access to this project's scope can pull the row.
    /// </summary>
    public Guid? ProjectId { get; set; }

    /// <summary>Client-supplied opaque tag (e.g. "collection", "request").</summary>
    public required string EntityType { get; set; }

    /// <summary>Client-supplied stable GUID for the row.</summary>
    public Guid EntityId { get; set; }

    /// <summary>"plain" (raw JSON) or "encrypted" (libsodium secretbox ciphertext).</summary>
    public required string PayloadFormat { get; set; }

    public byte[] Payload { get; set; } = [];

    /// <summary>For encrypted rows: JSON with salt/nonce/kdf params so other clients can decrypt.</summary>
    public string? CryptoHeader { get; set; }

    public DateTime UpdatedAt { get; set; }
    public DateTime? DeletedAt { get; set; }

    /// <summary>
    /// Monotonically-increasing per-organization counter. Used as the
    /// sync cursor. Per-org (not per-user) so every member of an org
    /// shares the same cursor space — cleaner than tracking N user
    /// cursors for the same shared dataset.
    /// </summary>
    public long Seq { get; set; }
}
