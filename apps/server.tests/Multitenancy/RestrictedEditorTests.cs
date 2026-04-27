using System.Net;
using Aelvory.Server.Dtos;
using Aelvory.Server.Entities;
using Aelvory.Server.Tests.Fixtures;
using Xunit;

namespace Aelvory.Server.Tests.Multitenancy;

/// <summary>
/// Restricted-editor flow — the one we just debugged in the real app.
///
/// Scenario:
///   1. B creates account → owns "B's workspace" with B as Owner.
///   2. B invites A as a restricted Editor.
///   3. B creates two projects: P1 and P2.
///   4. B grants A access to P1 only.
///
/// Expected:
///   - A's GET /api/organizations            includes B's workspace.
///   - A's GET /api/organizations/B/projects returns ONLY P1.
///   - A's GET on P1 succeeds; on P2 returns 403.
///   - A's POST /api/sync/push for an entity in P1 succeeds.
///   - A's POST /api/sync/push for an entity in P2 returns 403
///     (entire batch, not just the offending row).
///   - A's GET /api/sync/pull for B's org returns rows from P1
///     and from null-project (org-level) entries, never from P2.
/// </summary>
[Collection("postgres")]
public sealed class RestrictedEditorTests : IClassFixture<AelvoryFactory>, IAsyncLifetime
{
    private readonly AelvoryFactory _factory;
    public RestrictedEditorTests(AelvoryFactory factory) { _factory = factory; }

    public Task InitializeAsync() => _factory.ResetAsync();
    public Task DisposeAsync() => Task.CompletedTask;

    private async Task<Scenario> SetupAsync()
    {
        var b = await _factory.RegisterAsync(displayName: "Bob");
        var a = await _factory.RegisterAsync(displayName: "Alice");
        var orgId = await b.PersonalOrgIdAsync();

        // Invite A as restricted Editor in B's workspace.
        var aMember = await b.Api.PostAsync<MemberDto>(
            $"/api/organizations/{orgId}/members",
            new InviteMemberRequest(a.Email, MemberRole.Editor, true, null));

        // Create two projects in B's workspace.
        var p1 = await b.Api.PostAsync<ProjectDto>(
            $"/api/organizations/{orgId}/projects",
            new CreateProjectRequest("Project One", null));
        var p2 = await b.Api.PostAsync<ProjectDto>(
            $"/api/organizations/{orgId}/projects",
            new CreateProjectRequest("Project Two", null));

        // Grant A access to P1 only.
        await b.Api.PostAsync<ProjectMemberDto>(
            $"/api/projects/{p1.Id}/members",
            new GrantProjectAccessRequest(a.UserId));

        return new Scenario(B: b, A: a, OrgId: orgId, P1: p1, P2: p2, AMember: aMember);
    }

    [Fact]
    public async Task A_sees_B_workspace_in_org_list()
    {
        var s = await SetupAsync();
        var orgs = await s.A.Api.GetAsync<List<OrganizationDto>>("/api/organizations");
        Assert.Contains(orgs, o => o.Id == s.OrgId);
    }

    [Fact]
    public async Task A_sees_only_granted_project_in_workspace()
    {
        var s = await SetupAsync();
        var projects = await s.A.Api.GetAsync<List<ProjectDto>>(
            $"/api/organizations/{s.OrgId}/projects");

        // Critical assertion: P1 yes, P2 no. The server-side filter
        // for restricted Editors is what makes this possible without
        // a client-side check.
        Assert.Single(projects);
        Assert.Equal(s.P1.Id, projects[0].Id);
    }

    [Fact]
    public async Task A_can_GET_granted_project_but_not_other()
    {
        var s = await SetupAsync();

        var p1 = await s.A.Api.GetAsync<ProjectDto>(
            $"/api/organizations/{s.OrgId}/projects/{s.P1.Id}");
        Assert.Equal(s.P1.Id, p1.Id);

        var res = await s.A.Api.GetRawAsync(
            $"/api/organizations/{s.OrgId}/projects/{s.P2.Id}");
        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
    }

    [Fact]
    public async Task A_push_to_granted_project_succeeds()
    {
        var s = await SetupAsync();

        var entry = SyncEntries.NewCollection(orgId: s.OrgId, projectId: s.P1.Id);
        var res = await s.A.Api.PostRawAsync("/api/sync/push",
            new SyncPushRequest([entry]));

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var body = await ApiClient.ReadJsonAsync<SyncPushResponse>(res);
        Assert.NotNull(body);
        Assert.Equal(1, body!.Accepted);
    }

    [Fact]
    public async Task A_push_to_non_granted_project_rejects_whole_batch()
    {
        var s = await SetupAsync();

        // Mixed batch: one for P1 (allowed), one for P2 (denied).
        // Server semantics: reject the whole batch on a single scope
        // violation — partial accept would let buggy clients silently
        // half-write.
        var ok = SyncEntries.NewCollection(orgId: s.OrgId, projectId: s.P1.Id);
        var bad = SyncEntries.NewCollection(orgId: s.OrgId, projectId: s.P2.Id);

        var res = await s.A.Api.PostRawAsync("/api/sync/push",
            new SyncPushRequest([ok, bad]));

        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
    }

    [Fact]
    public async Task A_pull_returns_only_granted_and_org_level_entries()
    {
        var s = await SetupAsync();

        // Push from B (unrestricted owner): one entry per project plus
        // an org-level entry. All allowed for B.
        var p1Entry = SyncEntries.NewCollection(s.OrgId, s.P1.Id);
        var p2Entry = SyncEntries.NewCollection(s.OrgId, s.P2.Id);
        var orgLevel = SyncEntries.NewMember(s.OrgId);
        await s.B.Api.PostAsync<SyncPushResponse>("/api/sync/push",
            new SyncPushRequest([p1Entry, p2Entry, orgLevel]));

        // A pulls. Should see P1 + org-level, NEVER P2.
        var pull = await s.A.Api.GetAsync<SyncPullResponse>(
            $"/api/sync/pull?orgId={s.OrgId}&since=0");

        Assert.Contains(pull.Entries, e => e.EntityId == p1Entry.EntityId);
        Assert.Contains(pull.Entries, e => e.EntityId == orgLevel.EntityId);
        Assert.DoesNotContain(pull.Entries, e => e.EntityId == p2Entry.EntityId);
    }

    [Fact]
    public async Task Granted_project_is_invisible_to_A_after_revoke()
    {
        var s = await SetupAsync();

        // Find the grant id (A only sees their own — but the grant
        // list is admin-only, so go through B).
        var grants = await s.B.Api.GetAsync<List<ProjectMemberDto>>(
            $"/api/projects/{s.P1.Id}/members");
        var grant = Assert.Single(grants);

        await s.B.Api.DeleteAsync(
            $"/api/projects/{s.P1.Id}/members/{grant.Id}");

        // A's project list now drops back to empty for that org.
        var projects = await s.A.Api.GetAsync<List<ProjectDto>>(
            $"/api/organizations/{s.OrgId}/projects");
        Assert.Empty(projects);

        // And direct access to P1 is now 403.
        var res = await s.A.Api.GetRawAsync(
            $"/api/organizations/{s.OrgId}/projects/{s.P1.Id}");
        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
    }

    private sealed record Scenario(
        TestSession B,
        TestSession A,
        Guid OrgId,
        ProjectDto P1,
        ProjectDto P2,
        MemberDto AMember);
}
