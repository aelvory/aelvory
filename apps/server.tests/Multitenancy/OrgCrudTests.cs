using System.Net;
using Aelvory.Server.Dtos;
using Aelvory.Server.Entities;
using Aelvory.Server.Tests.Fixtures;
using Xunit;

namespace Aelvory.Server.Tests.Multitenancy;

/// <summary>
/// Org-level CRUD: create, rename, delete. The admin SPA's sidebar
/// CRUD UI lives on top of these, so a server-side regression here
/// would leave the New / Rename / Delete buttons silently broken.
///
/// Note on Delete's status code: the endpoint returns 404 (not 403)
/// for non-owner / wrong-kind / deleted attempts. That's deliberate —
/// the filter is folded into the EF query, so a non-owner can't
/// distinguish "this org doesn't exist" from "you're not allowed to
/// delete it". Tests pin that behaviour so it's not accidentally
/// flipped to a more leaky 403.
/// </summary>
[Collection("postgres")]
public sealed class OrgCrudTests : IClassFixture<AelvoryFactory>, IAsyncLifetime
{
    private readonly AelvoryFactory _factory;
    public OrgCrudTests(AelvoryFactory factory) { _factory = factory; }
    public Task InitializeAsync() => _factory.ResetAsync();
    public Task DisposeAsync() => Task.CompletedTask;

    [Fact]
    public async Task Create_makes_the_caller_owner_and_kind_team()
    {
        var s = await _factory.RegisterAsync();
        var created = await s.Api.PostAsync<OrganizationDto>(
            "/api/organizations",
            new CreateOrganizationRequest("Acme"));

        Assert.Equal("Acme", created.Name);
        Assert.Equal(OrganizationKind.Team, created.Kind);
        Assert.Equal(s.UserId, created.OwnerId);

        // The new org appears in the user's list alongside the
        // auto-created personal one.
        var orgs = await s.Api.GetAsync<List<OrganizationDto>>("/api/organizations");
        Assert.Equal(2, orgs.Count);
        Assert.Contains(orgs, o => o.Id == created.Id);
    }

    [Fact]
    public async Task Update_renames_when_caller_is_owner()
    {
        var s = await _factory.RegisterAsync();
        var orgId = await s.PersonalOrgIdAsync();

        var updated = await s.Api.PutAsync<OrganizationDto>(
            $"/api/organizations/{orgId}",
            new UpdateOrganizationRequest("Renamed Workspace"));

        Assert.Equal("Renamed Workspace", updated.Name);
        Assert.Equal(orgId, updated.Id);
    }

    [Fact]
    public async Task Update_by_admin_succeeds()
    {
        var owner = await _factory.RegisterAsync(displayName: "Owner");
        var admin = await _factory.RegisterAsync(displayName: "Admin");
        var orgId = await owner.PersonalOrgIdAsync();

        await owner.Api.PostAsync<MemberDto>(
            $"/api/organizations/{orgId}/members",
            new InviteMemberRequest(admin.Email, MemberRole.Admin, false, null));

        var updated = await admin.Api.PutAsync<OrganizationDto>(
            $"/api/organizations/{orgId}",
            new UpdateOrganizationRequest("Admin renamed it"));

        Assert.Equal("Admin renamed it", updated.Name);
    }

    [Fact]
    public async Task Update_by_editor_returns_404()
    {
        // Server gates Update on Owner/Admin and folds the check into
        // the EF query — Editors get 404 (not 403), same
        // information-hiding pattern as Delete. The UI's pencil icon
        // is gated by `isCurrentOrgAdmin` so this branch only fires
        // on direct API call / bookmarked URL.
        var owner = await _factory.RegisterAsync();
        var editor = await _factory.RegisterAsync();
        var orgId = await owner.PersonalOrgIdAsync();

        await owner.Api.PostAsync<MemberDto>(
            $"/api/organizations/{orgId}/members",
            new InviteMemberRequest(editor.Email, MemberRole.Editor, false, null));

        var res = await editor.Api.PutRawAsync(
            $"/api/organizations/{orgId}",
            new UpdateOrganizationRequest("Try"));
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    [Fact]
    public async Task Update_by_non_member_returns_404()
    {
        var alice = await _factory.RegisterAsync();
        var bob = await _factory.RegisterAsync();
        var bobOrgId = await bob.PersonalOrgIdAsync();

        var res = await alice.Api.PutRawAsync(
            $"/api/organizations/{bobOrgId}",
            new UpdateOrganizationRequest("Hijack"));
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    [Fact]
    public async Task Delete_succeeds_for_owner_of_team_org()
    {
        var s = await _factory.RegisterAsync();
        var team = await s.Api.PostAsync<OrganizationDto>(
            "/api/organizations",
            new CreateOrganizationRequest("Disposable"));

        await s.Api.DeleteAsync($"/api/organizations/{team.Id}");

        // Soft delete — DeletedAt is set, filtered out of the list.
        var orgs = await s.Api.GetAsync<List<OrganizationDto>>("/api/organizations");
        Assert.DoesNotContain(orgs, o => o.Id == team.Id);
    }

    [Fact]
    public async Task Delete_personal_org_returns_404()
    {
        // Personal orgs are tied to the user's identity (created at
        // register). Allowing deletion would orphan the user. The
        // controller filters Kind=Team in the query, so attempts to
        // delete a Personal org return 404 — same not-found semantics
        // as a foreign org.
        var s = await _factory.RegisterAsync();
        var personalId = await s.PersonalOrgIdAsync();

        var res = await s.Api.DeleteRawAsync($"/api/organizations/{personalId}");
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    [Fact]
    public async Task Delete_by_admin_returns_404()
    {
        // Only Owner can delete (not Admin). Admin gets 404. UI's
        // trash icon is gated by `isCurrentOrgDeletable` (Owner +
        // Team kind) so this branch only fires on direct API call.
        var owner = await _factory.RegisterAsync();
        var admin = await _factory.RegisterAsync();
        var team = await owner.Api.PostAsync<OrganizationDto>(
            "/api/organizations",
            new CreateOrganizationRequest("Team"));
        await owner.Api.PostAsync<MemberDto>(
            $"/api/organizations/{team.Id}/members",
            new InviteMemberRequest(admin.Email, MemberRole.Admin, false, null));

        var res = await admin.Api.DeleteRawAsync($"/api/organizations/{team.Id}");
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    [Fact]
    public async Task Delete_by_non_member_returns_404()
    {
        var alice = await _factory.RegisterAsync();
        var bob = await _factory.RegisterAsync();
        var team = await bob.Api.PostAsync<OrganizationDto>(
            "/api/organizations",
            new CreateOrganizationRequest("Bob's"));

        var res = await alice.Api.DeleteRawAsync($"/api/organizations/{team.Id}");
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }
}
