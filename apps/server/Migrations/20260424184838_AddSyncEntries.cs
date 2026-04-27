using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Aelvory.Server.Migrations
{
    /// <inheritdoc />
    public partial class AddSyncEntries : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "SyncEntries",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    EntityType = table.Column<string>(type: "text", nullable: false),
                    EntityId = table.Column<Guid>(type: "uuid", nullable: false),
                    PayloadFormat = table.Column<string>(type: "text", nullable: false),
                    Payload = table.Column<byte[]>(type: "bytea", nullable: false),
                    CryptoHeader = table.Column<string>(type: "text", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    DeletedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    Seq = table.Column<long>(type: "bigint", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SyncEntries", x => x.Id);
                    table.ForeignKey(
                        name: "FK_SyncEntries_Users_UserId",
                        column: x => x.UserId,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_SyncEntries_UserId_EntityType_EntityId",
                table: "SyncEntries",
                columns: new[] { "UserId", "EntityType", "EntityId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_SyncEntries_UserId_Seq",
                table: "SyncEntries",
                columns: new[] { "UserId", "Seq" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "SyncEntries");
        }
    }
}
