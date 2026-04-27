using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Aelvory.Server.Migrations
{
    /// <summary>
    /// Refresh tokens are now stored as SHA-256 hashes — the
    /// plaintext token never lives in the DB. Existing rows are
    /// truncated because we don't have the plaintext to hash; users
    /// re-sign-in once, then the new flow takes over.
    ///
    /// This is a one-shot migration: forward path drops Token,
    /// truncates the table, adds TokenHash. Reverse path
    /// reconstructs the schema but cannot recover any data (the
    /// hashes are one-way) — anyone rolling back has to live with
    /// every active session being invalidated.
    /// </summary>
    [Microsoft.EntityFrameworkCore.Infrastructure.DbContext(typeof(Data.AelvoryDbContext))]
    [Migration("20260426170000_HashRefreshTokens")]
    public partial class HashRefreshTokens : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Truncate first — every plaintext token in flight is
            // about to become unrecoverable when we drop the column.
            // Forcing a re-sign-in is cleaner than leaving an
            // orphan row that can't be matched against any client's
            // stored token.
            migrationBuilder.Sql(@"DELETE FROM ""RefreshTokens""");

            migrationBuilder.DropIndex(
                name: "IX_RefreshTokens_Token",
                table: "RefreshTokens");

            migrationBuilder.DropColumn(
                name: "Token",
                table: "RefreshTokens");

            migrationBuilder.AddColumn<string>(
                name: "TokenHash",
                table: "RefreshTokens",
                type: "text",
                nullable: false,
                defaultValue: "");

            migrationBuilder.CreateIndex(
                name: "IX_RefreshTokens_TokenHash",
                table: "RefreshTokens",
                column: "TokenHash",
                unique: true);
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(@"DELETE FROM ""RefreshTokens""");

            migrationBuilder.DropIndex(
                name: "IX_RefreshTokens_TokenHash",
                table: "RefreshTokens");

            migrationBuilder.DropColumn(
                name: "TokenHash",
                table: "RefreshTokens");

            migrationBuilder.AddColumn<string>(
                name: "Token",
                table: "RefreshTokens",
                type: "text",
                nullable: false,
                defaultValue: "");

            migrationBuilder.CreateIndex(
                name: "IX_RefreshTokens_Token",
                table: "RefreshTokens",
                column: "Token",
                unique: true);
        }
    }
}
