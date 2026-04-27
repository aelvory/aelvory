using System.Net;
using Aelvory.Server.Dtos;
using Aelvory.Server.Tests.Fixtures;
using Xunit;

namespace Aelvory.Server.Tests.Sync;

/// <summary>
/// Push and pull happy paths plus the well-known sad paths
/// (mixed-org batches, oversize batches, foreign-org pulls).
/// </summary>
[Collection("postgres")]
public sealed class PushPullTests : IClassFixture<AelvoryFactory>, IAsyncLifetime
{
    private readonly AelvoryFactory _factory;
    public PushPullTests(AelvoryFactory factory) { _factory = factory; }

    public Task InitializeAsync() => _factory.ResetAsync();
    public Task DisposeAsync() => Task.CompletedTask;

    [Fact]
    public async Task Empty_push_returns_zero_accepted_no_op()
    {
        var s = await _factory.RegisterAsync();
        var orgId = await s.PersonalOrgIdAsync();

        // The push controller short-circuits before the entry-validation
        // loop on an empty batch — we still need a sensible response.
        var res = await s.Api.PostAsync<SyncPushResponse>(
            "/api/sync/push", new SyncPushRequest([]));
        Assert.Equal(0, res.Accepted);
        Assert.Equal(0, res.Rejected);
        Assert.Empty(res.Conflicts);
    }

    [Fact]
    public async Task Push_then_pull_round_trips_entry()
    {
        var s = await _factory.RegisterAsync();
        var orgId = await s.PersonalOrgIdAsync();
        var project = await s.Api.PostAsync<ProjectDto>(
            $"/api/organizations/{orgId}/projects",
            new CreateProjectRequest("P", null));

        var entry = SyncEntries.NewCollection(orgId, project.Id);
        var pushRes = await s.Api.PostAsync<SyncPushResponse>(
            "/api/sync/push", new SyncPushRequest([entry]));
        Assert.Equal(1, pushRes.Accepted);
        Assert.True(pushRes.ServerCursor > 0);

        var pull = await s.Api.GetAsync<SyncPullResponse>(
            $"/api/sync/pull?orgId={orgId}&since=0");
        // Filter to the entry we pushed: project creation also writes
        // a SyncEntry now (admin endpoints publish into the sync log
        // for cross-device propagation), so an unfiltered pull would
        // see both the project and the collection we pushed.
        var got = Assert.Single(pull.Entries, e => e.EntityId == entry.EntityId);
        Assert.Equal(entry.EntityType, got.EntityType);
        // Server assigns its own Seq; whatever the client sent (0
        // here) is ignored. Server's value should match the cursor.
        Assert.Equal(pushRes.ServerCursor, got.Seq);
    }

    [Fact]
    public async Task Pull_with_since_filters_already_seen_entries()
    {
        var s = await _factory.RegisterAsync();
        var orgId = await s.PersonalOrgIdAsync();
        var project = await s.Api.PostAsync<ProjectDto>(
            $"/api/organizations/{orgId}/projects",
            new CreateProjectRequest("P", null));

        // First push, capture cursor.
        var first = SyncEntries.NewCollection(orgId, project.Id);
        var pushed1 = await s.Api.PostAsync<SyncPushResponse>(
            "/api/sync/push", new SyncPushRequest([first]));

        // Second push.
        var second = SyncEntries.NewCollection(orgId, project.Id);
        await s.Api.PostAsync<SyncPushResponse>(
            "/api/sync/push", new SyncPushRequest([second]));

        // Pull with since=cursor-of-first should only see the second.
        var pull = await s.Api.GetAsync<SyncPullResponse>(
            $"/api/sync/pull?orgId={orgId}&since={pushed1.ServerCursor}");
        var got = Assert.Single(pull.Entries, e => e.EntityId == second.EntityId);
        Assert.Equal(second.EntityId, got.EntityId);
    }

    [Fact]
    public async Task Cursor_is_per_organization_not_global()
    {
        // Two orgs, one user. Pushes into org A shouldn't move the
        // cursor for org B and vice versa. This is the property that
        // lets clients track N orgs with N independent cursors.
        var s = await _factory.RegisterAsync();
        var orgA = await s.PersonalOrgIdAsync();
        var orgB = await s.Api.PostAsync<OrganizationDto>(
            "/api/organizations",
            new CreateOrganizationRequest("Side workspace"));

        var pa = await s.Api.PostAsync<ProjectDto>(
            $"/api/organizations/{orgA}/projects",
            new CreateProjectRequest("PA", null));
        var pb = await s.Api.PostAsync<ProjectDto>(
            $"/api/organizations/{orgB.Id}/projects",
            new CreateProjectRequest("PB", null));

        // Read each org's pre-push cursor — admin-side project
        // creation (and org create for orgB) now publishes its own
        // SyncEntries, so the per-org Seq counter has already
        // advanced past 0 by the time we push. The "per-org cursor"
        // property still holds: whatever it is on each side, our
        // push should advance it by exactly one.
        var beforeA = (await s.Api.GetAsync<SyncPullResponse>(
            $"/api/sync/pull?orgId={orgA}&since=0")).ServerCursor;
        var beforeB = (await s.Api.GetAsync<SyncPullResponse>(
            $"/api/sync/pull?orgId={orgB.Id}&since=0")).ServerCursor;

        var pushA = await s.Api.PostAsync<SyncPushResponse>(
            "/api/sync/push",
            new SyncPushRequest([SyncEntries.NewCollection(orgA, pa.Id)]));
        var pushB = await s.Api.PostAsync<SyncPushResponse>(
            "/api/sync/push",
            new SyncPushRequest([SyncEntries.NewCollection(orgB.Id, pb.Id)]));

        // Each push advances its org's cursor by one — they don't
        // share counter space.
        Assert.Equal(beforeA + 1, pushA.ServerCursor);
        Assert.Equal(beforeB + 1, pushB.ServerCursor);
    }

    [Fact]
    public async Task Mixed_org_batch_returns_400()
    {
        var s = await _factory.RegisterAsync();
        var orgA = await s.PersonalOrgIdAsync();
        var orgB = await s.Api.PostAsync<OrganizationDto>(
            "/api/organizations", new CreateOrganizationRequest("B"));
        var pa = await s.Api.PostAsync<ProjectDto>(
            $"/api/organizations/{orgA}/projects",
            new CreateProjectRequest("PA", null));
        var pb = await s.Api.PostAsync<ProjectDto>(
            $"/api/organizations/{orgB.Id}/projects",
            new CreateProjectRequest("PB", null));

        var res = await s.Api.PostRawAsync("/api/sync/push",
            new SyncPushRequest([
                SyncEntries.NewCollection(orgA, pa.Id),
                SyncEntries.NewCollection(orgB.Id, pb.Id),
            ]));

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    [Fact]
    public async Task Push_to_org_user_does_not_belong_to_returns_403()
    {
        var alice = await _factory.RegisterAsync();
        var bob = await _factory.RegisterAsync();
        var bobOrg = await bob.PersonalOrgIdAsync();
        var bobProject = await bob.Api.PostAsync<ProjectDto>(
            $"/api/organizations/{bobOrg}/projects",
            new CreateProjectRequest("BP", null));

        var res = await alice.Api.PostRawAsync("/api/sync/push",
            new SyncPushRequest([SyncEntries.NewCollection(bobOrg, bobProject.Id)]));
        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
    }

    [Fact]
    public async Task Pull_from_org_user_does_not_belong_to_returns_403()
    {
        var alice = await _factory.RegisterAsync();
        var bob = await _factory.RegisterAsync();
        var bobOrg = await bob.PersonalOrgIdAsync();

        var res = await alice.Api.GetRawAsync(
            $"/api/sync/pull?orgId={bobOrg}&since=0");
        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
    }

    [Fact]
    public async Task Oversize_batch_returns_400()
    {
        var s = await _factory.RegisterAsync();
        var orgId = await s.PersonalOrgIdAsync();
        var project = await s.Api.PostAsync<ProjectDto>(
            $"/api/organizations/{orgId}/projects",
            new CreateProjectRequest("P", null));

        // MaxEntriesPerPush = 1000 (see SyncController). 1001 entries
        // tips it over.
        var entries = new List<SyncEntryDto>();
        for (var i = 0; i < 1001; i++)
        {
            entries.Add(SyncEntries.NewCollection(orgId, project.Id));
        }
        var res = await s.Api.PostRawAsync("/api/sync/push",
            new SyncPushRequest(entries));
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }
}
