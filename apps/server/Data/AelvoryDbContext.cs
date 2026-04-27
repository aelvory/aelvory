using Aelvory.Server.Entities;
using Microsoft.EntityFrameworkCore;

namespace Aelvory.Server.Data;

public class AelvoryDbContext(DbContextOptions<AelvoryDbContext> options) : DbContext(options)
{
    public DbSet<User> Users => Set<User>();
    public DbSet<Organization> Organizations => Set<Organization>();
    public DbSet<Member> Members => Set<Member>();

    /// <summary>
    /// Per-project access grants (Phase 2). Empty in Phase 1; the Phase 1
    /// migration creates the table so the entity model and database stay
    /// in sync, but no controller writes to it yet.
    /// </summary>
    public DbSet<ProjectMember> ProjectMembers => Set<ProjectMember>();

    public DbSet<Project> Projects => Set<Project>();
    public DbSet<ApiEnvironment> Environments => Set<ApiEnvironment>();
    public DbSet<Variable> Variables => Set<Variable>();
    public DbSet<Collection> Collections => Set<Collection>();
    public DbSet<ApiRequest> Requests => Set<ApiRequest>();
    public DbSet<Script> Scripts => Set<Script>();
    public DbSet<ActivityLog> ActivityLogs => Set<ActivityLog>();
    public DbSet<RefreshToken> RefreshTokens => Set<RefreshToken>();
    public DbSet<SyncEntry> SyncEntries => Set<SyncEntry>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<User>()
            .HasIndex(u => u.Email)
            .IsUnique();

        b.Entity<Member>()
            .HasIndex(m => new { m.OrganizationId, m.UserId })
            .IsUnique();

        b.Entity<ProjectMember>()
            .HasIndex(pm => new { pm.ProjectId, pm.UserId })
            .IsUnique();
        b.Entity<ProjectMember>()
            .HasIndex(pm => pm.UserId);

        b.Entity<RefreshToken>()
            .HasIndex(t => t.TokenHash)
            .IsUnique();

        b.Entity<RefreshToken>()
            .HasIndex(t => new { t.UserId, t.ExpiresAt });

        b.Entity<Variable>()
            .HasIndex(v => new { v.Scope, v.ScopeId, v.Key })
            .IsUnique();

        b.Entity<Collection>()
            .HasOne<Collection>()
            .WithMany()
            .HasForeignKey(c => c.ParentId)
            .OnDelete(DeleteBehavior.Cascade);

        b.Entity<ActivityLog>()
            .HasIndex(a => new { a.OrganizationId, a.Timestamp });

        // SyncEntry indexes — multi-tenant variant.
        //
        // Uniqueness key changed from (UserId, EntityType, EntityId) to
        // (OrganizationId, EntityType, EntityId): the tenant is the
        // organization, and we want exactly one row per logical entity
        // per org. UserId moves from "primary scope" to "writer
        // metadata" (who pushed the latest version) and gets indexed
        // separately for the rare case of querying "what did I push?".
        b.Entity<SyncEntry>()
            .HasIndex(e => new { e.OrganizationId, e.EntityType, e.EntityId })
            .IsUnique();
        b.Entity<SyncEntry>()
            .HasIndex(e => new { e.OrganizationId, e.Seq });
        b.Entity<SyncEntry>()
            .HasIndex(e => e.UserId);
        b.Entity<SyncEntry>()
            .HasIndex(e => e.ProjectId);

        // Project ↔ Organization (Team layer was dropped in this phase).
        b.Entity<Project>()
            .HasOne(p => p.Organization)
            .WithMany(o => o.Projects)
            .HasForeignKey(p => p.OrganizationId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}
