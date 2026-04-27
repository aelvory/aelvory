using System.Net;
using Aelvory.Server.Dtos;
using Aelvory.Server.Entities;
using Aelvory.Server.Tests.Fixtures;
using Xunit;

namespace Aelvory.Server.Tests.Multitenancy;

/// <summary>
/// /api/projects/{id}/members is owner/admin-only by design — it's
/// where grants are listed and managed. Surfacing it to an Editor
/// (the bug we just fixed in OrgProjects.vue) means the client gets
/// a 403 on click. These tests pin the server side of that gate.
/// </summary>
[Collection("postgres")]
public sealed class ProjectMembersTests : IClassFixture<AelvoryFactory>, IAsyncLifetime
{
    private readonly AelvoryFactory _factory;
    public ProjectMembersTests(AelvoryFactory factory) { _factory = factory; }

    public Task InitializeAsync() => _factory.ResetAsync();
    public Task DisposeAsync() => Task.CompletedTask;

    [Fact]
    public async Task Owner_can_list_grants()
    {
        var owner = await _factory.RegisterAsync();
        var orgId = await owner.PersonalOrgIdAsync();
        var project = await owner.Api.PostAsync<ProjectDto>(
            $"/api/organizations/{orgId}/projects",
            new CreateProjectRequest("P", null));

        var grants = await owner.Api.GetAsync<List<ProjectMemberDto>>(
            $"/api/projects/{project.Id}/members");
        Assert.Empty(grants);
    }

    [Fact]
    public async Task Editor_listing_grants_returns_403()
    {
        var owner = await _factory.RegisterAsync();
        var editor = await _factory.RegisterAsync();
        var orgId = await owner.PersonalOrgIdAsync();

        var project = await owner.Api.PostAsync<ProjectDto>(
            $"/api/organizations/{orgId}/projects",
            new CreateProjectRequest("P", null));
        await owner.Api.PostAsync<MemberDto>(
            $"/api/organizations/{orgId}/members",
            new InviteMemberRequest(editor.Email, MemberRole.Editor, false, null));

        var res = await editor.Api.GetRawAsync($"/api/projects/{project.Id}/members");
        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
    }

    [Fact]
    public async Task Restricted_editor_listing_grants_returns_403()
    {
        // Same gate — restricted vs unrestricted shouldn't matter for
        // /api/projects/.../members. Only role does.
        var owner = await _factory.RegisterAsync();
        var editor = await _factory.RegisterAsync();
        var orgId = await owner.PersonalOrgIdAsync();
        var project = await owner.Api.PostAsync<ProjectDto>(
            $"/api/organizations/{orgId}/projects",
            new CreateProjectRequest("P", null));
        await owner.Api.PostAsync<MemberDto>(
            $"/api/organizations/{orgId}/members",
            new InviteMemberRequest(editor.Email, MemberRole.Editor, true, null));
        await owner.Api.PostAsync<ProjectMemberDto>(
            $"/api/projects/{project.Id}/members",
            new GrantProjectAccessRequest(editor.UserId));

        var res = await editor.Api.GetRawAsync($"/api/projects/{project.Id}/members");
        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
    }

    [Fact]
    public async Task Granting_to_non_org_member_returns_400()
    {
        // It doesn't make sense to grant per-project access to someone
        // who can't pull the org at all. The controller short-circuits
        // with not_org_member.
        var owner = await _factory.RegisterAsync();
        var stranger = await _factory.RegisterAsync();
        var orgId = await owner.PersonalOrgIdAsync();
        var project = await owner.Api.PostAsync<ProjectDto>(
            $"/api/organizations/{orgId}/projects",
            new CreateProjectRequest("P", null));

        var res = await owner.Api.PostRawAsync(
            $"/api/projects/{project.Id}/members",
            new GrantProjectAccessRequest(stranger.UserId));
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    [Fact]
    public async Task Duplicate_grant_returns_409()
    {
        var owner = await _factory.RegisterAsync();
        var editor = await _factory.RegisterAsync();
        var orgId = await owner.PersonalOrgIdAsync();

        var project = await owner.Api.PostAsync<ProjectDto>(
            $"/api/organizations/{orgId}/projects",
            new CreateProjectRequest("P", null));
        await owner.Api.PostAsync<MemberDto>(
            $"/api/organizations/{orgId}/members",
            new InviteMemberRequest(editor.Email, MemberRole.Editor, true, null));
        await owner.Api.PostAsync<ProjectMemberDto>(
            $"/api/projects/{project.Id}/members",
            new GrantProjectAccessRequest(editor.UserId));

        var res = await owner.Api.PostRawAsync(
            $"/api/projects/{project.Id}/members",
            new GrantProjectAccessRequest(editor.UserId));
        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
    }

    [Fact]
    public async Task Project_delete_is_owner_admin_only_even_with_grant()
    {
        // Restricted Editor with grant on a project — they can read
        // and write content via sync, but project deletion is a
        // higher-impact action gated to org admins regardless of
        // grant status.
        var owner = await _factory.RegisterAsync();
        var editor = await _factory.RegisterAsync();
        var orgId = await owner.PersonalOrgIdAsync();

        var project = await owner.Api.PostAsync<ProjectDto>(
            $"/api/organizations/{orgId}/projects",
            new CreateProjectRequest("P", null));
        await owner.Api.PostAsync<MemberDto>(
            $"/api/organizations/{orgId}/members",
            new InviteMemberRequest(editor.Email, MemberRole.Editor, true, null));
        await owner.Api.PostAsync<ProjectMemberDto>(
            $"/api/projects/{project.Id}/members",
            new GrantProjectAccessRequest(editor.UserId));

        var res = await editor.Api.DeleteRawAsync(
            $"/api/organizations/{orgId}/projects/{project.Id}");
        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
    }
}
