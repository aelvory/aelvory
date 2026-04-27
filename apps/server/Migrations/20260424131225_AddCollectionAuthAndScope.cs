using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Aelvory.Server.Migrations
{
    /// <inheritdoc />
    public partial class AddCollectionAuthAndScope : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "AuthJson",
                table: "Collections",
                type: "text",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "AuthJson",
                table: "Collections");
        }
    }
}
