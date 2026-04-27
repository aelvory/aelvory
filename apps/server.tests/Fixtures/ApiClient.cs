using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Aelvory.Server.Tests.Fixtures;

/// <summary>
/// Thin wrapper around the WAF's <see cref="HttpClient"/> that:
///   - serialises bodies + parses responses with the same JSON options
///     the server itself uses (camelCase property names, camelCase
///     enum strings),
///   - lets a test set a Bearer token once and forget about it,
///   - exposes typed helpers for the response shape (<see cref="GetAsync{T}"/>
///     etc.) AND raw <see cref="HttpResponseMessage"/> for the cases
///     where the test asserts on status code instead of body
///     (<see cref="GetRawAsync"/>).
///
/// We deliberately don't add convenience methods that hide the status
/// code — every "did this user just get 403?" check must be visible in
/// the test body, not buried.
/// </summary>
public sealed class ApiClient
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    private readonly HttpClient _http;

    public ApiClient(HttpClient http)
    {
        _http = http;
    }

    /// <summary>
    /// Set/clear the Bearer token used for subsequent requests. Pass
    /// <c>null</c> to drop the token (e.g. testing the unauthenticated
    /// path on an endpoint that's normally authed).
    /// </summary>
    public string? Token
    {
        set
        {
            _http.DefaultRequestHeaders.Authorization = value is null
                ? null
                : new AuthenticationHeaderValue("Bearer", value);
        }
    }

    public async Task<T> GetAsync<T>(string path)
    {
        var res = await _http.GetAsync(path);
        res.EnsureSuccessStatusCode();
        return (await res.Content.ReadFromJsonAsync<T>(Json))!;
    }

    public Task<HttpResponseMessage> GetRawAsync(string path) => _http.GetAsync(path);

    public async Task<T> PostAsync<T>(string path, object? body)
    {
        var res = await _http.PostAsJsonAsync(path, body, Json);
        res.EnsureSuccessStatusCode();
        return (await res.Content.ReadFromJsonAsync<T>(Json))!;
    }

    public async Task<HttpResponseMessage> PostRawAsync(string path, object? body)
    {
        return await _http.PostAsJsonAsync(path, body, Json);
    }

    public async Task<T> PutAsync<T>(string path, object body)
    {
        var res = await _http.PutAsJsonAsync(path, body, Json);
        res.EnsureSuccessStatusCode();
        return (await res.Content.ReadFromJsonAsync<T>(Json))!;
    }

    public async Task<HttpResponseMessage> PutRawAsync(string path, object body)
    {
        return await _http.PutAsJsonAsync(path, body, Json);
    }

    public async Task DeleteAsync(string path)
    {
        var res = await _http.DeleteAsync(path);
        res.EnsureSuccessStatusCode();
    }

    public Task<HttpResponseMessage> DeleteRawAsync(string path) => _http.DeleteAsync(path);

    /// <summary>
    /// Convenience for the "this should fail" branch of a test. The
    /// caller wants to read the body and assert on a non-2xx status —
    /// <see cref="HttpResponseMessage.EnsureSuccessStatusCode"/> would
    /// throw, but the test is asserting on the failure deliberately.
    /// </summary>
    public static async Task<T?> ReadJsonAsync<T>(HttpResponseMessage res)
    {
        if (res.Content.Headers.ContentLength is 0 or null)
            return default;
        return await res.Content.ReadFromJsonAsync<T>(Json);
    }
}
