using System.Net;
using Aelvory.Server.Dtos;
using Aelvory.Server.Entities;
using Aelvory.Server.Tests.Fixtures;
using Xunit;

namespace Aelvory.Server.Tests.Multitenancy;

/// <summary>
/// The admin UI's project list (<c>GET /projects/all</c>) reads from the
/// sync log, not the canonical Projects table, so projects created on the
/// desktop — which only ever arrive as SyncEntries — are visible. These
/// tests pin that behaviour plus the view/manage and access scoping.
/// </summary>
[Collection("postgres")]
public sealed class ProjectsListAllTests : IClassFixture<AelvoryFactory>, IAsyncLifetime
{
    private readonly AelvoryFactory _factory;
    public ProjectsListAllTests(AelvoryFactory factory) { _factory = factory; }

    public Task InitializeAsync() => _factory.ResetAsync();
    public Task DisposeAsync() => Task.CompletedTask;

    [Fact]
    public async Task Desktop_pushed_project_appears_and_is_view_only()
    {
        var s = await _factory.RegisterAsync();
        var orgId = await s.PersonalOrgIdAsync();

        // Simulate a desktop-created project: it reaches the server only
        // as a sync entry, never via POST /projects, so there is no
        // canonical Projects row.
        await s.Api.PostAsync<SyncPushResponse>("/api/sync/push",
            new SyncPushRequest([SyncEntries.NewProject(orgId, name: "From desktop")]));

        var list = await s.Api.GetAsync<List<AdminProjectDto>>(
            $"/api/organizations/{orgId}/projects/all");

        // The canonical list would be empty here — that was the bug.
        var canonical = await s.Api.GetAsync<List<ProjectDto>>(
            $"/api/organizations/{orgId}/projects");
        Assert.Empty(canonical);

        var row = Assert.Single(list);
        Assert.Equal("From desktop", row.Name);
        Assert.False(row.Encrypted);
        Assert.False(row.Manageable); // no Projects row → view-only in admin
    }

    [Fact]
    public async Task Admin_created_project_is_manageable()
    {
        var s = await _factory.RegisterAsync();
        var orgId = await s.PersonalOrgIdAsync();
        var p = await s.Api.PostAsync<ProjectDto>(
            $"/api/organizations/{orgId}/projects",
            new CreateProjectRequest("Admin made", "desc"));

        var list = await s.Api.GetAsync<List<AdminProjectDto>>(
            $"/api/organizations/{orgId}/projects/all");

        var row = Assert.Single(list);
        Assert.Equal(p.Id, row.Id);
        Assert.Equal("Admin made", row.Name);
        Assert.Equal("desc", row.Description);
        Assert.False(row.Encrypted);
        Assert.True(row.Manageable); // canonical Projects row exists
    }

    [Fact]
    public async Task Encrypted_project_is_flagged_and_nameless()
    {
        var s = await _factory.RegisterAsync();
        var orgId = await s.PersonalOrgIdAsync();

        await s.Api.PostAsync<SyncPushResponse>("/api/sync/push",
            new SyncPushRequest([SyncEntries.NewEncryptedProject(orgId)]));

        var list = await s.Api.GetAsync<List<AdminProjectDto>>(
            $"/api/organizations/{orgId}/projects/all");

        var row = Assert.Single(list);
        Assert.True(row.Encrypted);
        Assert.Null(row.Name); // server can't read an E2EE payload
        Assert.False(row.Manageable);
    }

    [Fact]
    public async Task Tombstoned_project_is_excluded()
    {
        var s = await _factory.RegisterAsync();
        var orgId = await s.PersonalOrgIdAsync();
        var id = Guid.NewGuid();
        var t0 = DateTime.UtcNow.AddMinutes(-1);
        var t1 = DateTime.UtcNow;

        await s.Api.PostAsync<SyncPushResponse>("/api/sync/push",
            new SyncPushRequest([SyncEntries.NewProject(orgId, id, "Doomed", updatedAt: t0)]));
        // Tombstone the same entity id with a newer timestamp.
        await s.Api.PostAsync<SyncPushResponse>("/api/sync/push",
            new SyncPushRequest([
                SyncEntries.NewProject(orgId, id, "Doomed", updatedAt: t1) with { DeletedAt = t1 },
            ]));

        var list = await s.Api.GetAsync<List<AdminProjectDto>>(
            $"/api/organizations/{orgId}/projects/all");
        Assert.Empty(list);
    }

    [Fact]
    public async Task Restricted_editor_only_sees_granted_projects()
    {
        var owner = await _factory.RegisterAsync(displayName: "Owner");
        var editor = await _factory.RegisterAsync(displayName: "Editor");
        var orgId = await owner.PersonalOrgIdAsync();

        // Admin-created so they're grantable (grant anchors on db.Projects).
        var granted = await owner.Api.PostAsync<ProjectDto>(
            $"/api/organizations/{orgId}/projects",
            new CreateProjectRequest("Granted", null));
        await owner.Api.PostAsync<ProjectDto>(
            $"/api/organizations/{orgId}/projects",
            new CreateProjectRequest("Hidden", null));

        await owner.Api.PostAsync<MemberDto>(
            $"/api/organizations/{orgId}/members",
            new InviteMemberRequest(editor.Email, MemberRole.Editor, true, null));
        await owner.Api.PostAsync<ProjectMemberDto>(
            $"/api/projects/{granted.Id}/members",
            new GrantProjectAccessRequest(editor.UserId));

        var list = await editor.Api.GetAsync<List<AdminProjectDto>>(
            $"/api/organizations/{orgId}/projects/all");

        var row = Assert.Single(list);
        Assert.Equal(granted.Id, row.Id);
    }

    [Fact]
    public async Task Stats_counts_a_desktop_pushed_project()
    {
        var s = await _factory.RegisterAsync();
        var orgId = await s.PersonalOrgIdAsync();
        var projectId = Guid.NewGuid();

        // Desktop project + a collection under it, both via sync only.
        await s.Api.PostAsync<SyncPushResponse>("/api/sync/push",
            new SyncPushRequest([
                SyncEntries.NewProject(orgId, projectId, "Desktop"),
                SyncEntries.NewCollection(orgId, projectId),
            ]));

        var stats = await s.Api.GetAsync<List<ProjectStatsDto>>(
            $"/api/organizations/{orgId}/projects/stats");

        // Before the fix, Stats sourced project ids from db.Projects, so a
        // desktop project produced no stats row at all.
        var row = Assert.Single(stats);
        Assert.Equal(projectId, row.ProjectId);
        Assert.Equal(1, row.CollectionCount);
    }

    [Fact]
    public async Task List_for_foreign_org_returns_403()
    {
        var alice = await _factory.RegisterAsync();
        var bob = await _factory.RegisterAsync();
        var bobOrgId = await bob.PersonalOrgIdAsync();

        var res = await alice.Api.GetRawAsync(
            $"/api/organizations/{bobOrgId}/projects/all");
        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
    }
}
