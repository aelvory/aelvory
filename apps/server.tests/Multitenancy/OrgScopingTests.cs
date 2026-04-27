using System.Net;
using Aelvory.Server.Dtos;
using Aelvory.Server.Entities;
using Aelvory.Server.Tests.Fixtures;
using Xunit;

namespace Aelvory.Server.Tests.Multitenancy;

/// <summary>
/// Cross-org isolation. The "User A can only see / mutate things in
/// orgs they're a member of" guarantee is the load-bearing piece of
/// the multi-tenant model — these tests pin that down.
/// </summary>
[Collection("postgres")]
public sealed class OrgScopingTests : IClassFixture<AelvoryFactory>, IAsyncLifetime
{
    private readonly AelvoryFactory _factory;
    public OrgScopingTests(AelvoryFactory factory) { _factory = factory; }

    public Task InitializeAsync() => _factory.ResetAsync();
    public Task DisposeAsync() => Task.CompletedTask;

    [Fact]
    public async Task ListOrganizations_returns_only_orgs_the_user_belongs_to()
    {
        // A and B each get their own personal org at register. They
        // shouldn't be able to see the other's org without an explicit
        // invite.
        var alice = await _factory.RegisterAsync(displayName: "Alice");
        var bob = await _factory.RegisterAsync(displayName: "Bob");

        var aliceOrgs = await alice.Api.GetAsync<List<OrganizationDto>>("/api/organizations");
        var bobOrgs = await bob.Api.GetAsync<List<OrganizationDto>>("/api/organizations");

        Assert.Single(aliceOrgs);
        Assert.Single(bobOrgs);
        Assert.NotEqual(aliceOrgs[0].Id, bobOrgs[0].Id);
    }

    [Fact]
    public async Task ListMembers_of_a_foreign_org_returns_404()
    {
        // Returns 404 (not 403) — matches the GET /{id} behaviour
        // for the same condition. Both endpoints behave the same
        // way to a probing attacker so org id existence isn't
        // leaked via the Forbid-vs-NotFound oracle.
        var alice = await _factory.RegisterAsync(displayName: "Alice");
        var bob = await _factory.RegisterAsync(displayName: "Bob");
        var bobOrgId = await bob.PersonalOrgIdAsync();

        var res = await alice.Api.GetRawAsync($"/api/organizations/{bobOrgId}/members");
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    [Fact]
    public async Task ListProjects_of_a_foreign_org_returns_403()
    {
        var alice = await _factory.RegisterAsync(displayName: "Alice");
        var bob = await _factory.RegisterAsync(displayName: "Bob");
        var bobOrgId = await bob.PersonalOrgIdAsync();

        var res = await alice.Api.GetRawAsync($"/api/organizations/{bobOrgId}/projects");
        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
    }

    [Fact]
    public async Task Org_admin_can_invite_existing_user_as_editor()
    {
        var admin = await _factory.RegisterAsync(displayName: "Admin");
        var invitee = await _factory.RegisterAsync(displayName: "Invitee");
        var orgId = await admin.PersonalOrgIdAsync();

        var member = await admin.Api.PostAsync<MemberDto>(
            $"/api/organizations/{orgId}/members",
            new InviteMemberRequest(invitee.Email, MemberRole.Editor, false, null));

        Assert.Equal(invitee.UserId, member.UserId);
        Assert.Equal(MemberRole.Editor, member.Role);

        // Now the invitee sees the org in their list.
        var orgs = await invitee.Api.GetAsync<List<OrganizationDto>>("/api/organizations");
        Assert.Equal(2, orgs.Count); // own personal + admin's
        Assert.Contains(orgs, o => o.Id == orgId);
    }

    [Fact]
    public async Task Invite_unknown_email_returns_404()
    {
        var admin = await _factory.RegisterAsync();
        var orgId = await admin.PersonalOrgIdAsync();

        var res = await admin.Api.PostRawAsync(
            $"/api/organizations/{orgId}/members",
            new InviteMemberRequest("ghost@nowhere.test",
                MemberRole.Editor, false, null));

        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    [Fact]
    public async Task Invite_same_user_twice_returns_409()
    {
        var admin = await _factory.RegisterAsync();
        var invitee = await _factory.RegisterAsync();
        var orgId = await admin.PersonalOrgIdAsync();

        await admin.Api.PostAsync<MemberDto>(
            $"/api/organizations/{orgId}/members",
            new InviteMemberRequest(invitee.Email, MemberRole.Editor, false, null));

        var res = await admin.Api.PostRawAsync(
            $"/api/organizations/{orgId}/members",
            new InviteMemberRequest(invitee.Email, MemberRole.Editor, false, null));

        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
    }

    [Fact]
    public async Task Editor_cannot_invite_other_members()
    {
        var owner = await _factory.RegisterAsync(displayName: "Owner");
        var editor = await _factory.RegisterAsync(displayName: "Editor");
        var third = await _factory.RegisterAsync(displayName: "Third");
        var orgId = await owner.PersonalOrgIdAsync();

        await owner.Api.PostAsync<MemberDto>(
            $"/api/organizations/{orgId}/members",
            new InviteMemberRequest(editor.Email, MemberRole.Editor, false, null));

        var res = await editor.Api.PostRawAsync(
            $"/api/organizations/{orgId}/members",
            new InviteMemberRequest(third.Email, MemberRole.Editor, false, null));

        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
    }

    [Fact]
    public async Task Restricted_flag_is_ignored_for_owner_admin_invites()
    {
        // The controller silently strips the restricted flag for any
        // role that isn't Editor — owners/admins are conceptually
        // unrestricted by definition. Guard against a regression that
        // would persist a Restricted=true admin and surprise downstream
        // gates.
        var owner = await _factory.RegisterAsync();
        var invitee = await _factory.RegisterAsync();
        var orgId = await owner.PersonalOrgIdAsync();

        var member = await owner.Api.PostAsync<MemberDto>(
            $"/api/organizations/{orgId}/members",
            new InviteMemberRequest(invitee.Email, MemberRole.Admin, true, null));

        Assert.False(member.Restricted);
    }
}
