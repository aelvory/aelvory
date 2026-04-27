using Aelvory.Server.Dtos;
using Aelvory.Server.Tests.Fixtures;
using Xunit;

namespace Aelvory.Server.Tests.Sync;

/// <summary>
/// Conflict semantics: server stores last-writer-wins by UpdatedAt,
/// reports rejected pushes back to the client so it knows to re-pull
/// the canonical version.
/// </summary>
[Collection("postgres")]
public sealed class ConflictAndCursorTests : IClassFixture<AelvoryFactory>, IAsyncLifetime
{
    private readonly AelvoryFactory _factory;
    public ConflictAndCursorTests(AelvoryFactory factory) { _factory = factory; }

    public Task InitializeAsync() => _factory.ResetAsync();
    public Task DisposeAsync() => Task.CompletedTask;

    [Fact]
    public async Task Newer_push_overwrites_older_existing_row()
    {
        var s = await _factory.RegisterAsync();
        var orgId = await s.PersonalOrgIdAsync();
        var project = await s.Api.PostAsync<ProjectDto>(
            $"/api/organizations/{orgId}/projects",
            new CreateProjectRequest("P", null));

        var entityId = Guid.NewGuid();
        var t0 = DateTime.UtcNow.AddMinutes(-1);
        var t1 = DateTime.UtcNow;

        await s.Api.PostAsync<SyncPushResponse>("/api/sync/push",
            new SyncPushRequest([
                SyncEntries.NewCollection(orgId, project.Id, entityId, t0),
            ]));
        var second = await s.Api.PostAsync<SyncPushResponse>("/api/sync/push",
            new SyncPushRequest([
                SyncEntries.NewCollection(orgId, project.Id, entityId, t1),
            ]));

        // Both writes accepted; the newer UpdatedAt wins. No conflicts
        // because the second is strictly newer.
        Assert.Equal(1, second.Accepted);
        Assert.Empty(second.Conflicts);

        // Pull returns the collection row with the newer UpdatedAt.
        // Filter to the entityId we actually pushed — the project
        // creation also writes a SyncEntry now.
        var pull = await s.Api.GetAsync<SyncPullResponse>(
            $"/api/sync/pull?orgId={orgId}&since=0");
        var row = Assert.Single(pull.Entries, e => e.EntityId == entityId);
        // Tolerate Postgres' microsecond rounding.
        Assert.Equal(t1, row.UpdatedAt, TimeSpan.FromMilliseconds(1));
    }

    [Fact]
    public async Task Older_push_against_newer_existing_row_returns_conflict()
    {
        var s = await _factory.RegisterAsync();
        var orgId = await s.PersonalOrgIdAsync();
        var project = await s.Api.PostAsync<ProjectDto>(
            $"/api/organizations/{orgId}/projects",
            new CreateProjectRequest("P", null));

        var entityId = Guid.NewGuid();
        var newer = DateTime.UtcNow;
        var older = newer.AddMinutes(-1);

        // Establish a "newer" row on the server first.
        await s.Api.PostAsync<SyncPushResponse>("/api/sync/push",
            new SyncPushRequest([
                SyncEntries.NewCollection(orgId, project.Id, entityId, newer),
            ]));

        // Now push an older version. Server should reject and report
        // a conflict — the canonical state is the newer one already
        // there, and the client is expected to re-pull it.
        var res = await s.Api.PostAsync<SyncPushResponse>("/api/sync/push",
            new SyncPushRequest([
                SyncEntries.NewCollection(orgId, project.Id, entityId, older),
            ]));

        Assert.Equal(0, res.Accepted);
        Assert.Equal(1, res.Rejected);
        var conflict = Assert.Single(res.Conflicts);
        Assert.Equal(entityId, conflict.EntityId);
        Assert.Equal("collections", conflict.EntityType);
    }

    [Fact]
    public async Task Equal_updatedAt_treats_incoming_as_winner()
    {
        // The controller's check is "server > client" (strictly newer).
        // Equal UpdatedAt means the client's write is accepted (an idle
        // re-push of the same row is harmless). This pins the
        // boundary so a future refactor doesn't accidentally flip it
        // to >= and start treating idempotent re-pushes as conflicts.
        var s = await _factory.RegisterAsync();
        var orgId = await s.PersonalOrgIdAsync();
        var project = await s.Api.PostAsync<ProjectDto>(
            $"/api/organizations/{orgId}/projects",
            new CreateProjectRequest("P", null));

        var entityId = Guid.NewGuid();
        var ts = DateTime.UtcNow;

        await s.Api.PostAsync<SyncPushResponse>("/api/sync/push",
            new SyncPushRequest([SyncEntries.NewCollection(orgId, project.Id, entityId, ts)]));
        var second = await s.Api.PostAsync<SyncPushResponse>("/api/sync/push",
            new SyncPushRequest([SyncEntries.NewCollection(orgId, project.Id, entityId, ts)]));

        Assert.Equal(1, second.Accepted);
        Assert.Empty(second.Conflicts);
    }

    [Fact]
    public async Task Empty_pull_advances_cursor_to_org_max()
    {
        // Even when a restricted user's own slice has no new entries,
        // the cursor needs to move forward — otherwise they'd keep
        // re-pulling the same gap forever. The controller advances to
        // the org's max Seq when entries.Count == 0.
        var s = await _factory.RegisterAsync();
        var orgId = await s.PersonalOrgIdAsync();
        var project = await s.Api.PostAsync<ProjectDto>(
            $"/api/organizations/{orgId}/projects",
            new CreateProjectRequest("P", null));

        // Seed three rows.
        var pushed = await s.Api.PostAsync<SyncPushResponse>("/api/sync/push",
            new SyncPushRequest([
                SyncEntries.NewCollection(orgId, project.Id),
                SyncEntries.NewCollection(orgId, project.Id),
                SyncEntries.NewCollection(orgId, project.Id),
            ]));
        Assert.Equal(3, pushed.Accepted);
        var maxSeq = pushed.ServerCursor;

        // Pull from the very end → empty entries, cursor stays at maxSeq.
        var pull = await s.Api.GetAsync<SyncPullResponse>(
            $"/api/sync/pull?orgId={orgId}&since={maxSeq}");
        Assert.Empty(pull.Entries);
        Assert.Equal(maxSeq, pull.ServerCursor);
    }
}
