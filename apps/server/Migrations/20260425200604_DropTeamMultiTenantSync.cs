using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Aelvory.Server.Migrations
{
    /// <summary>
    /// Phase 1 of the multi-tenant rework:
    ///  1. Drops the Team layer; Projects now belong directly to an
    ///     Organization. Project.TeamId is renamed to OrganizationId
    ///     and its values are rewritten from team-ids to the team's
    ///     organization-id BEFORE the Teams table is dropped.
    ///  2. Adds OrganizationId + ProjectId to SyncEntries so push/pull
    ///     can scope entries by tenant. Existing entries are backfilled
    ///     using each writer's owned organization (pre-multi-tenant data
    ///     was always single-user, so the writer's personal org is the
    ///     correct scope). Entries whose writer has no owned org are
    ///     dropped — should be impossible in practice.
    ///  3. Drops the (UserId, EntityType, EntityId) and (UserId, Seq)
    ///     unique indexes; replaces them with (OrganizationId, …) per
    ///     the multi-tenant model.
    ///  4. Adds Members.Restricted (no-op for now; Phase 2 enforces it).
    ///  5. Creates the ProjectMembers grant table (empty in Phase 1;
    ///     populated by Phase 2's web UI for restricted Editors).
    ///
    /// Down recreates Teams as a placeholder org → team identity (every
    /// project becomes its own team named after itself) so the Up can
    /// be reversed without losing project rows. The down path is
    /// best-effort and primarily exists for development rollbacks.
    /// </summary>
    public partial class DropTeamMultiTenantSync : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // ---- Project ↦ Organization (drop Team layer) ----

            // Drop the old FK so the rename below doesn't violate the
            // constraint while we hold team-ids in the renamed column.
            migrationBuilder.DropForeignKey(
                name: "FK_Projects_Teams_TeamId",
                table: "Projects");

            migrationBuilder.RenameColumn(
                name: "TeamId",
                table: "Projects",
                newName: "OrganizationId");

            migrationBuilder.RenameIndex(
                name: "IX_Projects_TeamId",
                table: "Projects",
                newName: "IX_Projects_OrganizationId");

            // Rewrite the OrganizationId column on Projects from team-ids
            // to actual org-ids. MUST run before dropping Teams.
            migrationBuilder.Sql(@"
                UPDATE ""Projects"" p
                SET ""OrganizationId"" = t.""OrganizationId""
                FROM ""Teams"" t
                WHERE p.""OrganizationId"" = t.""Id"";
            ");

            migrationBuilder.DropTable(
                name: "Teams");

            migrationBuilder.AddForeignKey(
                name: "FK_Projects_Organizations_OrganizationId",
                table: "Projects",
                column: "OrganizationId",
                principalTable: "Organizations",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);

            // ---- SyncEntries: tenant-scope columns ----

            migrationBuilder.DropIndex(
                name: "IX_SyncEntries_UserId_EntityType_EntityId",
                table: "SyncEntries");

            migrationBuilder.DropIndex(
                name: "IX_SyncEntries_UserId_Seq",
                table: "SyncEntries");

            // Add as nullable initially so the backfill SQL can populate
            // it; we'll AlterColumn to NOT NULL afterwards.
            migrationBuilder.AddColumn<Guid>(
                name: "OrganizationId",
                table: "SyncEntries",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "ProjectId",
                table: "SyncEntries",
                type: "uuid",
                nullable: true);

            // Backfill SyncEntries.OrganizationId from the writer's
            // oldest owned organization. For pre-multi-tenant data this
            // is correct: each user only ever wrote to their own data,
            // which lived in their (single) personal org.
            migrationBuilder.Sql(@"
                UPDATE ""SyncEntries"" e
                SET ""OrganizationId"" = (
                    SELECT o.""Id""
                    FROM ""Organizations"" o
                    WHERE o.""OwnerId"" = e.""UserId""
                    ORDER BY o.""CreatedAt"" ASC
                    LIMIT 1
                )
                WHERE e.""OrganizationId"" IS NULL;
            ");

            // Defensive: drop any entries we couldn't attribute. In
            // practice every user has a personal org, so this should
            // remove zero rows.
            migrationBuilder.Sql(@"
                DELETE FROM ""SyncEntries"" WHERE ""OrganizationId"" IS NULL;
            ");

            migrationBuilder.AlterColumn<Guid>(
                name: "OrganizationId",
                table: "SyncEntries",
                type: "uuid",
                nullable: false,
                oldClrType: typeof(Guid),
                oldType: "uuid",
                oldNullable: true);

            // ---- Members.Restricted ----

            migrationBuilder.AddColumn<bool>(
                name: "Restricted",
                table: "Members",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            // ---- ProjectMembers (Phase 2 will populate it) ----

            migrationBuilder.CreateTable(
                name: "ProjectMembers",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ProjectId = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    GrantedBy = table.Column<Guid>(type: "uuid", nullable: false),
                    GrantedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ProjectMembers", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ProjectMembers_Projects_ProjectId",
                        column: x => x.ProjectId,
                        principalTable: "Projects",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_ProjectMembers_Users_UserId",
                        column: x => x.UserId,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            // ---- Indexes ----

            migrationBuilder.CreateIndex(
                name: "IX_SyncEntries_OrganizationId_EntityType_EntityId",
                table: "SyncEntries",
                columns: new[] { "OrganizationId", "EntityType", "EntityId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_SyncEntries_OrganizationId_Seq",
                table: "SyncEntries",
                columns: new[] { "OrganizationId", "Seq" });

            migrationBuilder.CreateIndex(
                name: "IX_SyncEntries_ProjectId",
                table: "SyncEntries",
                column: "ProjectId");

            migrationBuilder.CreateIndex(
                name: "IX_SyncEntries_UserId",
                table: "SyncEntries",
                column: "UserId");

            migrationBuilder.CreateIndex(
                name: "IX_ProjectMembers_ProjectId_UserId",
                table: "ProjectMembers",
                columns: new[] { "ProjectId", "UserId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_ProjectMembers_UserId",
                table: "ProjectMembers",
                column: "UserId");

            // ---- SyncEntries FK to Organizations ----

            migrationBuilder.AddForeignKey(
                name: "FK_SyncEntries_Organizations_OrganizationId",
                table: "SyncEntries",
                column: "OrganizationId",
                principalTable: "Organizations",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_Projects_Organizations_OrganizationId",
                table: "Projects");

            migrationBuilder.DropForeignKey(
                name: "FK_SyncEntries_Organizations_OrganizationId",
                table: "SyncEntries");

            migrationBuilder.DropTable(
                name: "ProjectMembers");

            migrationBuilder.DropIndex(
                name: "IX_SyncEntries_OrganizationId_EntityType_EntityId",
                table: "SyncEntries");

            migrationBuilder.DropIndex(
                name: "IX_SyncEntries_OrganizationId_Seq",
                table: "SyncEntries");

            migrationBuilder.DropIndex(
                name: "IX_SyncEntries_ProjectId",
                table: "SyncEntries");

            migrationBuilder.DropIndex(
                name: "IX_SyncEntries_UserId",
                table: "SyncEntries");

            migrationBuilder.DropColumn(
                name: "OrganizationId",
                table: "SyncEntries");

            migrationBuilder.DropColumn(
                name: "ProjectId",
                table: "SyncEntries");

            migrationBuilder.DropColumn(
                name: "Restricted",
                table: "Members");

            migrationBuilder.RenameColumn(
                name: "OrganizationId",
                table: "Projects",
                newName: "TeamId");

            migrationBuilder.RenameIndex(
                name: "IX_Projects_OrganizationId",
                table: "Projects",
                newName: "IX_Projects_TeamId");

            migrationBuilder.CreateTable(
                name: "Teams",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    OrganizationId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    DeletedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    Description = table.Column<string>(type: "text", nullable: true),
                    Name = table.Column<string>(type: "text", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    Version = table.Column<int>(type: "integer", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Teams", x => x.Id);
                    table.ForeignKey(
                        name: "FK_Teams_Organizations_OrganizationId",
                        column: x => x.OrganizationId,
                        principalTable: "Organizations",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            // Best-effort restore: turn each Project into its own Team.
            // Down paths are primarily for dev rollbacks; production
            // rollback isn't supported with full data fidelity (some
            // grouping intent was lost when Teams were dropped).
            migrationBuilder.Sql(@"
                INSERT INTO ""Teams"" (""Id"", ""OrganizationId"", ""Name"", ""CreatedAt"", ""UpdatedAt"", ""Version"")
                SELECT p.""Id"", p.""TeamId"", p.""Name"", p.""CreatedAt"", p.""UpdatedAt"", 0
                FROM ""Projects"" p;

                UPDATE ""Projects"" SET ""TeamId"" = ""Id"";
            ");

            migrationBuilder.CreateIndex(
                name: "IX_SyncEntries_UserId_EntityType_EntityId",
                table: "SyncEntries",
                columns: new[] { "UserId", "EntityType", "EntityId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_SyncEntries_UserId_Seq",
                table: "SyncEntries",
                columns: new[] { "UserId", "Seq" });

            migrationBuilder.CreateIndex(
                name: "IX_Teams_OrganizationId",
                table: "Teams",
                column: "OrganizationId");

            migrationBuilder.AddForeignKey(
                name: "FK_Projects_Teams_TeamId",
                table: "Projects",
                column: "TeamId",
                principalTable: "Teams",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);
        }
    }
}
