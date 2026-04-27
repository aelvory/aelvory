using System.Net;
using Aelvory.Server.Dtos;
using Aelvory.Server.Entities;
using Aelvory.Server.Tests.Fixtures;
using Xunit;

namespace Aelvory.Server.Tests.Multitenancy;

/// <summary>
/// Per-project content counts surface in the admin UI's project list.
/// Counts derive from <c>SyncEntries</c> (the entity tables for
/// Collections/Requests/etc. aren't populated — actual content is
/// pushed by clients as opaque sync payloads).
/// </summary>
[Collection("postgres")]
public sealed class ProjectStatsTests : IClassFixture<AelvoryFactory>, IAsyncLifetime
{
    private readonly AelvoryFactory _factory;
    public ProjectStatsTests(AelvoryFactory factory) { _factory = factory; }

    public Task InitializeAsync() => _factory.ResetAsync();
    public Task DisposeAsync() => Task.CompletedTask;

    [Fact]
    public async Task Empty_project_returns_all_zeros()
    {
        var s = await _factory.RegisterAsync();
        var orgId = await s.PersonalOrgIdAsync();
        var p = await s.Api.PostAsync<ProjectDto>(
            $"/api/organizations/{orgId}/projects",
            new CreateProjectRequest("Empty", null));

        var stats = await s.Api.GetAsync<List<ProjectStatsDto>>(
            $"/api/organizations/{orgId}/projects/stats");

        // A project with no pushed content still shows up — the UI
        // wants every visible project on screen, even the empty ones.
        var row = Assert.Single(stats);
        Assert.Equal(p.Id, row.ProjectId);
        Assert.Equal(0, row.CollectionCount);
        Assert.Equal(0, row.RequestCount);
        Assert.Equal(0, row.EnvironmentCount);
        Assert.Equal(0, row.VariableCount);
    }

    [Fact]
    public async Task Counts_each_entity_type_independently()
    {
        var s = await _factory.RegisterAsync();
        var orgId = await s.PersonalOrgIdAsync();
        var p = await s.Api.PostAsync<ProjectDto>(
            $"/api/organizations/{orgId}/projects",
            new CreateProjectRequest("Loaded", null));

        // Push: 2 collections, 3 requests. The stats endpoint groups
        // SyncEntries by EntityType so these should land in different
        // counters.
        await s.Api.PostAsync<SyncPushResponse>("/api/sync/push",
            new SyncPushRequest([
                SyncEntries.NewCollection(orgId, p.Id),
                SyncEntries.NewCollection(orgId, p.Id),
                SyncEntries.NewRequest(orgId, p.Id),
                SyncEntries.NewRequest(orgId, p.Id),
                SyncEntries.NewRequest(orgId, p.Id),
            ]));

        var stats = await s.Api.GetAsync<List<ProjectStatsDto>>(
            $"/api/organizations/{orgId}/projects/stats");
        var row = Assert.Single(stats);
        Assert.Equal(2, row.CollectionCount);
        Assert.Equal(3, row.RequestCount);
        Assert.Equal(0, row.EnvironmentCount);
        Assert.Equal(0, row.VariableCount);
    }

    [Fact]
    public async Task Tombstoned_entries_do_not_count()
    {
        // Push then "delete" via DeletedAt — server stores the row
        // but the stats endpoint must exclude it. Otherwise a project
        // that's been gradually emptied would still show its old
        // count and the UI would lie.
        var s = await _factory.RegisterAsync();
        var orgId = await s.PersonalOrgIdAsync();
        var p = await s.Api.PostAsync<ProjectDto>(
            $"/api/organizations/{orgId}/projects",
            new CreateProjectRequest("P", null));

        var entityId = Guid.NewGuid();
        var t0 = DateTime.UtcNow.AddMinutes(-1);
        var t1 = DateTime.UtcNow;

        // Live row.
        await s.Api.PostAsync<SyncPushResponse>("/api/sync/push",
            new SyncPushRequest([
                SyncEntries.NewCollection(orgId, p.Id, entityId, t0),
            ]));

        // Tombstone the same EntityId. PushAsync re-uses the row and
        // sets DeletedAt — same UpdatedAt-newer rule applies.
        var tombstoned = SyncEntries.NewCollection(orgId, p.Id, entityId, t1)
            with { DeletedAt = t1 };
        await s.Api.PostAsync<SyncPushResponse>("/api/sync/push",
            new SyncPushRequest([tombstoned]));

        var stats = await s.Api.GetAsync<List<ProjectStatsDto>>(
            $"/api/organizations/{orgId}/projects/stats");
        var row = Assert.Single(stats);
        Assert.Equal(0, row.CollectionCount);
    }

    [Fact]
    public async Task Stats_are_per_project_not_aggregated_across_org()
    {
        var s = await _factory.RegisterAsync();
        var orgId = await s.PersonalOrgIdAsync();
        var p1 = await s.Api.PostAsync<ProjectDto>(
            $"/api/organizations/{orgId}/projects",
            new CreateProjectRequest("P1", null));
        var p2 = await s.Api.PostAsync<ProjectDto>(
            $"/api/organizations/{orgId}/projects",
            new CreateProjectRequest("P2", null));

        await s.Api.PostAsync<SyncPushResponse>("/api/sync/push",
            new SyncPushRequest([
                SyncEntries.NewCollection(orgId, p1.Id),
                SyncEntries.NewCollection(orgId, p1.Id),
                SyncEntries.NewCollection(orgId, p2.Id),
            ]));

        var stats = await s.Api.GetAsync<List<ProjectStatsDto>>(
            $"/api/organizations/{orgId}/projects/stats");
        Assert.Equal(2, stats.Count);
        Assert.Equal(2, stats.First(x => x.ProjectId == p1.Id).CollectionCount);
        Assert.Equal(1, stats.First(x => x.ProjectId == p2.Id).CollectionCount);
    }

    [Fact]
    public async Task Restricted_editor_only_sees_stats_for_granted_projects()
    {
        // Same scoping rule as ProjectsController.List: a restricted
        // Editor's stats list must not leak counts for projects they
        // can't access. Otherwise the admin UI would inadvertently
        // surface the existence of other projects to them.
        var owner = await _factory.RegisterAsync(displayName: "Owner");
        var editor = await _factory.RegisterAsync(displayName: "Editor");
        var orgId = await owner.PersonalOrgIdAsync();

        var p1 = await owner.Api.PostAsync<ProjectDto>(
            $"/api/organizations/{orgId}/projects",
            new CreateProjectRequest("Granted", null));
        var p2 = await owner.Api.PostAsync<ProjectDto>(
            $"/api/organizations/{orgId}/projects",
            new CreateProjectRequest("Hidden", null));

        await owner.Api.PostAsync<MemberDto>(
            $"/api/organizations/{orgId}/members",
            new InviteMemberRequest(editor.Email, MemberRole.Editor, true, null));
        await owner.Api.PostAsync<ProjectMemberDto>(
            $"/api/projects/{p1.Id}/members",
            new GrantProjectAccessRequest(editor.UserId));

        // Owner pushes content into both projects.
        await owner.Api.PostAsync<SyncPushResponse>("/api/sync/push",
            new SyncPushRequest([
                SyncEntries.NewCollection(orgId, p1.Id),
                SyncEntries.NewCollection(orgId, p2.Id),
                SyncEntries.NewCollection(orgId, p2.Id),
            ]));

        // Editor sees stats only for the project they have a grant on.
        var stats = await editor.Api.GetAsync<List<ProjectStatsDto>>(
            $"/api/organizations/{orgId}/projects/stats");
        var row = Assert.Single(stats);
        Assert.Equal(p1.Id, row.ProjectId);
        Assert.Equal(1, row.CollectionCount);
    }

    [Fact]
    public async Task Stats_for_foreign_org_returns_403()
    {
        var alice = await _factory.RegisterAsync();
        var bob = await _factory.RegisterAsync();
        var bobOrgId = await bob.PersonalOrgIdAsync();

        var res = await alice.Api.GetRawAsync(
            $"/api/organizations/{bobOrgId}/projects/stats");
        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
    }
}
