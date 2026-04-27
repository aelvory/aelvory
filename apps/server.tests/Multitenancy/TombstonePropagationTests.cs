using Aelvory.Server.Dtos;
using Aelvory.Server.Entities;
using Aelvory.Server.Tests.Fixtures;
using Xunit;

namespace Aelvory.Server.Tests.Multitenancy;

/// <summary>
/// Admin-UI mutations should reflect into the sync log so connected
/// desktops pull the change via the same realtime path as a desktop
/// push. Without this, the admin endpoints and the sync log are
/// disconnected and changes silently fail to propagate
/// cross-device.
///
/// Each test asserts the SyncEntry shape that desktops will see on
/// their next /api/sync/pull, not the SignalR broadcast itself —
/// SignalR delivery is exercised at integration time and checking
/// the wire log here is what catches "controller forgot to call
/// SyncEntityBridge.PublishAsync" regressions.
/// </summary>
[Collection("postgres")]
public sealed class TombstonePropagationTests : IClassFixture<AelvoryFactory>, IAsyncLifetime
{
    private readonly AelvoryFactory _factory;
    public TombstonePropagationTests(AelvoryFactory factory) { _factory = factory; }
    public Task InitializeAsync() => _factory.ResetAsync();
    public Task DisposeAsync() => Task.CompletedTask;

    [Fact]
    public async Task Project_create_publishes_sync_entry()
    {
        var s = await _factory.RegisterAsync();
        var orgId = await s.PersonalOrgIdAsync();

        var project = await s.Api.PostAsync<ProjectDto>(
            $"/api/organizations/{orgId}/projects",
            new CreateProjectRequest("Test", null));

        var pull = await s.Api.GetAsync<SyncPullResponse>(
            $"/api/sync/pull?orgId={orgId}&since=0");
        var entry = Assert.Single(pull.Entries, e => e.EntityId == project.Id);
        Assert.Equal("projects", entry.EntityType);
        Assert.Null(entry.DeletedAt);
        Assert.Equal(project.Id, entry.ProjectId);
    }

    [Fact]
    public async Task Project_update_publishes_sync_entry_with_new_payload()
    {
        var s = await _factory.RegisterAsync();
        var orgId = await s.PersonalOrgIdAsync();
        var project = await s.Api.PostAsync<ProjectDto>(
            $"/api/organizations/{orgId}/projects",
            new CreateProjectRequest("Initial", null));

        var renamed = await s.Api.PutAsync<ProjectDto>(
            $"/api/organizations/{orgId}/projects/{project.Id}",
            new UpdateProjectRequest("Renamed", null));

        // The most recent entry for this project should reflect the
        // rename — sync layer's last-writer-wins folds rapid edits
        // onto a single row.
        var pull = await s.Api.GetAsync<SyncPullResponse>(
            $"/api/sync/pull?orgId={orgId}&since=0");
        var entry = Assert.Single(pull.Entries, e => e.EntityId == project.Id);
        Assert.Null(entry.DeletedAt);
        // We don't decode the payload bytes here (that's the desktop's
        // job) — the contract is just "an entry exists with the new
        // updatedAt." Confirms the controller called PublishAsync on
        // the update path.
        Assert.Equal(renamed.UpdatedAt, entry.UpdatedAt, TimeSpan.FromMilliseconds(1));
    }

    [Fact]
    public async Task Project_delete_publishes_tombstone()
    {
        // The whole point: an admin deleting a project in the web UI
        // should produce a SyncEntry the desktop can consume to remove
        // its local copy. Without this, removed projects ghost-haunt
        // every desktop indefinitely.
        var s = await _factory.RegisterAsync();
        var orgId = await s.PersonalOrgIdAsync();
        var team = await s.Api.PostAsync<OrganizationDto>(
            "/api/organizations", new CreateOrganizationRequest("Team"));
        var project = await s.Api.PostAsync<ProjectDto>(
            $"/api/organizations/{team.Id}/projects",
            new CreateProjectRequest("Doomed", null));

        await s.Api.DeleteAsync($"/api/organizations/{team.Id}/projects/{project.Id}");

        var pull = await s.Api.GetAsync<SyncPullResponse>(
            $"/api/sync/pull?orgId={team.Id}&since=0");
        var entry = Assert.Single(pull.Entries, e => e.EntityId == project.Id);
        Assert.NotNull(entry.DeletedAt);
        Assert.Equal("projects", entry.EntityType);
    }

    [Fact]
    public async Task Org_create_publishes_org_and_owner_member_entries()
    {
        // Both the new org row AND the owner's Member row need to
        // ride the sync log — the desktop's `members` table needs
        // *some* row to satisfy the local sync engine's scope
        // resolution for subsequent pushes into this org.
        var s = await _factory.RegisterAsync();
        var team = await s.Api.PostAsync<OrganizationDto>(
            "/api/organizations", new CreateOrganizationRequest("Acme"));

        var pull = await s.Api.GetAsync<SyncPullResponse>(
            $"/api/sync/pull?orgId={team.Id}&since=0");
        Assert.Contains(pull.Entries,
            e => e.EntityType == "organizations" && e.EntityId == team.Id && e.DeletedAt is null);
        Assert.Contains(pull.Entries,
            e => e.EntityType == "members" && e.DeletedAt is null);
    }

    [Fact]
    public async Task Org_delete_publishes_tombstone()
    {
        var s = await _factory.RegisterAsync();
        var team = await s.Api.PostAsync<OrganizationDto>(
            "/api/organizations", new CreateOrganizationRequest("Disposable"));

        await s.Api.DeleteAsync($"/api/organizations/{team.Id}");

        var pull = await s.Api.GetAsync<SyncPullResponse>(
            $"/api/sync/pull?orgId={team.Id}&since=0");
        var entry = Assert.Single(
            pull.Entries, e => e.EntityType == "organizations" && e.EntityId == team.Id);
        Assert.NotNull(entry.DeletedAt);
    }

    [Fact]
    public async Task Member_invite_publishes_member_entry()
    {
        var owner = await _factory.RegisterAsync();
        var invitee = await _factory.RegisterAsync();
        var orgId = await owner.PersonalOrgIdAsync();

        var member = await owner.Api.PostAsync<MemberDto>(
            $"/api/organizations/{orgId}/members",
            new InviteMemberRequest(invitee.Email, MemberRole.Editor, false, null));

        var pull = await owner.Api.GetAsync<SyncPullResponse>(
            $"/api/sync/pull?orgId={orgId}&since=0");
        var entry = Assert.Single(
            pull.Entries, e => e.EntityType == "members" && e.EntityId == member.Id);
        Assert.Null(entry.DeletedAt);
    }

    [Fact]
    public async Task Member_remove_publishes_tombstone()
    {
        // Members table on the desktop has no `deleted_at` column;
        // desktop applyIncoming hard-DELETEs by id when DeletedAt is
        // set on the envelope. The wire-side check here is just that
        // the tombstone is present.
        var owner = await _factory.RegisterAsync();
        var invitee = await _factory.RegisterAsync();
        var orgId = await owner.PersonalOrgIdAsync();
        var member = await owner.Api.PostAsync<MemberDto>(
            $"/api/organizations/{orgId}/members",
            new InviteMemberRequest(invitee.Email, MemberRole.Editor, false, null));

        await owner.Api.DeleteAsync(
            $"/api/organizations/{orgId}/members/{member.Id}");

        var pull = await owner.Api.GetAsync<SyncPullResponse>(
            $"/api/sync/pull?orgId={orgId}&since=0");
        var entry = Assert.Single(
            pull.Entries, e => e.EntityType == "members" && e.EntityId == member.Id);
        Assert.NotNull(entry.DeletedAt);
    }

    [Fact]
    public async Task Project_member_grant_publishes_entry()
    {
        var owner = await _factory.RegisterAsync();
        var editor = await _factory.RegisterAsync();
        var orgId = await owner.PersonalOrgIdAsync();
        await owner.Api.PostAsync<MemberDto>(
            $"/api/organizations/{orgId}/members",
            new InviteMemberRequest(editor.Email, MemberRole.Editor, true, null));
        var project = await owner.Api.PostAsync<ProjectDto>(
            $"/api/organizations/{orgId}/projects",
            new CreateProjectRequest("P", null));

        var grant = await owner.Api.PostAsync<ProjectMemberDto>(
            $"/api/projects/{project.Id}/members",
            new GrantProjectAccessRequest(editor.UserId));

        var pull = await owner.Api.GetAsync<SyncPullResponse>(
            $"/api/sync/pull?orgId={orgId}&since=0");
        var entry = Assert.Single(
            pull.Entries, e => e.EntityType == "project_members" && e.EntityId == grant.Id);
        Assert.Null(entry.DeletedAt);
        Assert.Equal(project.Id, entry.ProjectId);
    }

    [Fact]
    public async Task Project_member_revoke_publishes_tombstone()
    {
        var owner = await _factory.RegisterAsync();
        var editor = await _factory.RegisterAsync();
        var orgId = await owner.PersonalOrgIdAsync();
        await owner.Api.PostAsync<MemberDto>(
            $"/api/organizations/{orgId}/members",
            new InviteMemberRequest(editor.Email, MemberRole.Editor, true, null));
        var project = await owner.Api.PostAsync<ProjectDto>(
            $"/api/organizations/{orgId}/projects",
            new CreateProjectRequest("P", null));
        var grant = await owner.Api.PostAsync<ProjectMemberDto>(
            $"/api/projects/{project.Id}/members",
            new GrantProjectAccessRequest(editor.UserId));

        await owner.Api.DeleteAsync(
            $"/api/projects/{project.Id}/members/{grant.Id}");

        var pull = await owner.Api.GetAsync<SyncPullResponse>(
            $"/api/sync/pull?orgId={orgId}&since=0");
        var entry = Assert.Single(
            pull.Entries, e => e.EntityType == "project_members" && e.EntityId == grant.Id);
        Assert.NotNull(entry.DeletedAt);
    }

    [Fact]
    public async Task Tombstone_advances_per_org_cursor()
    {
        // A tombstone is a real SyncEntry with its own Seq — it must
        // advance the cursor so /api/sync/pull?since=<old> returns it
        // exactly once. Without this, deletions could be skipped or
        // pulled repeatedly.
        var s = await _factory.RegisterAsync();
        var orgId = await s.PersonalOrgIdAsync();
        var team = await s.Api.PostAsync<OrganizationDto>(
            "/api/organizations", new CreateOrganizationRequest("Team"));
        var project = await s.Api.PostAsync<ProjectDto>(
            $"/api/organizations/{team.Id}/projects",
            new CreateProjectRequest("P", null));

        var beforePull = await s.Api.GetAsync<SyncPullResponse>(
            $"/api/sync/pull?orgId={team.Id}&since=0");
        var cursorBefore = beforePull.ServerCursor;

        await s.Api.DeleteAsync($"/api/organizations/{team.Id}/projects/{project.Id}");

        var afterPull = await s.Api.GetAsync<SyncPullResponse>(
            $"/api/sync/pull?orgId={team.Id}&since={cursorBefore}");
        Assert.NotEmpty(afterPull.Entries);
        Assert.True(afterPull.ServerCursor > cursorBefore);
        Assert.Contains(afterPull.Entries, e => e.EntityId == project.Id && e.DeletedAt is not null);
    }
}
