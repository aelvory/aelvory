using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using Aelvory.Server.Dtos;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Aelvory.Server.Controllers;

[ApiController]
[Authorize]
[Route("api/runner")]
public class RunnerController(IHttpClientFactory httpFactory, ILogger<RunnerController> log) : ControllerBase
{
    private static readonly HashSet<string> BlockedHosts = new(StringComparer.OrdinalIgnoreCase)
    {
        "localhost", "127.0.0.1", "::1", "0.0.0.0",
    };

    private static readonly string[] RestrictedHeaderPrefixes = ["content-"];

    [HttpPost("execute")]
    public async Task<ActionResult<ExecuteResponse>> Execute(
        [FromBody] ExecuteRequest req,
        CancellationToken ct)
    {
        if (!Uri.TryCreate(req.Url, UriKind.Absolute, out var uri))
            return BadRequest(new { error = "invalid_url" });

        if (uri.Scheme is not ("http" or "https"))
            return BadRequest(new { error = "unsupported_scheme" });

        if (BlockedHosts.Contains(uri.Host) || IsInternalIp(uri.Host))
            return BadRequest(new { error = "blocked_host", message = "requests to localhost/internal IPs are blocked (SSRF protection)" });

        var client = httpFactory.CreateClient("runner");
        client.Timeout = TimeSpan.FromMilliseconds(req.TimeoutMs ?? 60_000);

        using var msg = new HttpRequestMessage(new HttpMethod(req.Method.ToUpperInvariant()), uri);

        var contentHeaders = new List<HeaderDto>();
        foreach (var h in req.Headers ?? [])
        {
            if (!h.Enabled || string.IsNullOrWhiteSpace(h.Key)) continue;
            if (IsContentHeader(h.Key))
            {
                contentHeaders.Add(h);
                continue;
            }
            msg.Headers.TryAddWithoutValidation(h.Key, h.Value);
        }

        if (req.Auth is not null)
        {
            ApplyAuth(msg, req.Auth);
        }

        if (req.Body is { Type: not "none" } body && !string.IsNullOrEmpty(body.Raw))
        {
            msg.Content = new StringContent(
                body.Raw,
                Encoding.UTF8,
                body.ContentType ?? "application/json");
            foreach (var h in contentHeaders)
            {
                msg.Content.Headers.Remove(h.Key);
                msg.Content.Headers.TryAddWithoutValidation(h.Key, h.Value);
            }
        }

        // Snapshot composed request headers before sending so the UI can
        // show what actually went over the wire (including Authorization,
        // content-type, content-length, etc.).
        var requestHeaders = SnapshotRequestHeaders(msg);
        var finalUrl = msg.RequestUri?.ToString() ?? req.Url;
        var finalMethod = msg.Method.Method;

        var sw = Stopwatch.StartNew();
        HttpResponseMessage response;
        try
        {
            response = await client.SendAsync(msg, HttpCompletionOption.ResponseContentRead, ct);
        }
        catch (TaskCanceledException)
        {
            sw.Stop();
            return new ExecuteResponse(0, "", [], requestHeaders, finalUrl, finalMethod, "", sw.ElapsedMilliseconds, 0, null, "timeout");
        }
        catch (HttpRequestException ex)
        {
            sw.Stop();
            log.LogDebug(ex, "Runner network error");
            return new ExecuteResponse(0, "", [], requestHeaders, finalUrl, finalMethod, "", sw.ElapsedMilliseconds, 0, null, ex.Message);
        }
        sw.Stop();

        var bodyBytes = await response.Content.ReadAsByteArrayAsync(ct);
        var bodyStr = TryDecode(bodyBytes, response.Content.Headers.ContentType?.CharSet);

        var headers = new List<HeaderDto>();
        foreach (var h in response.Headers)
            foreach (var v in h.Value)
                headers.Add(new HeaderDto(h.Key, v, true));
        foreach (var h in response.Content.Headers)
            foreach (var v in h.Value)
                headers.Add(new HeaderDto(h.Key, v, true));

        return new ExecuteResponse(
            (int)response.StatusCode,
            response.ReasonPhrase ?? HttpStatusCodeToText(response.StatusCode),
            headers,
            requestHeaders,
            finalUrl,
            finalMethod,
            bodyStr,
            sw.ElapsedMilliseconds,
            bodyBytes.LongLength,
            response.Content.Headers.ContentType?.ToString(),
            null);
    }

    private static List<HeaderDto> SnapshotRequestHeaders(HttpRequestMessage msg)
    {
        var list = new List<HeaderDto>();
        foreach (var h in msg.Headers)
            foreach (var v in h.Value)
                list.Add(new HeaderDto(h.Key, v, true));
        if (msg.Content is not null)
        {
            foreach (var h in msg.Content.Headers)
                foreach (var v in h.Value)
                    list.Add(new HeaderDto(h.Key, v, true));
        }
        return list;
    }

    private static void ApplyAuth(HttpRequestMessage msg, AuthConfigDto auth)
    {
        if (auth.Config is null) return;
        switch (auth.Type?.ToLowerInvariant())
        {
            case "basic":
                {
                    var u = GetString(auth.Config, "username");
                    var p = GetString(auth.Config, "password");
                    if (u is not null)
                    {
                        var creds = Convert.ToBase64String(Encoding.UTF8.GetBytes($"{u}:{p ?? ""}"));
                        msg.Headers.Authorization = new AuthenticationHeaderValue("Basic", creds);
                    }
                    break;
                }
            case "bearer":
                {
                    var token = GetString(auth.Config, "token");
                    if (!string.IsNullOrEmpty(token))
                        msg.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
                    break;
                }
            case "apikey":
                {
                    var key = GetString(auth.Config, "key");
                    var value = GetString(auth.Config, "value");
                    var where = GetString(auth.Config, "in") ?? "header";
                    if (!string.IsNullOrEmpty(key) && where == "header")
                        msg.Headers.TryAddWithoutValidation(key, value ?? "");
                    break;
                }
        }
    }

    private static string? GetString(Dictionary<string, object> d, string key) =>
        d.TryGetValue(key, out var v) ? v?.ToString() : null;

    private static bool IsContentHeader(string name) =>
        RestrictedHeaderPrefixes.Any(p => name.StartsWith(p, StringComparison.OrdinalIgnoreCase));

    private static bool IsInternalIp(string host)
    {
        if (!IPAddress.TryParse(host, out var ip)) return false;
        var bytes = ip.GetAddressBytes();
        if (ip.AddressFamily is System.Net.Sockets.AddressFamily.InterNetwork)
        {
            return bytes[0] == 10
                || (bytes[0] == 172 && bytes[1] >= 16 && bytes[1] <= 31)
                || (bytes[0] == 192 && bytes[1] == 168)
                || (bytes[0] == 169 && bytes[1] == 254)
                || bytes[0] == 127;
        }
        return ip.IsIPv6LinkLocal || ip.IsIPv6SiteLocal || IPAddress.IsLoopback(ip);
    }

    private static string TryDecode(byte[] bytes, string? charset)
    {
        if (bytes.Length == 0) return "";
        try
        {
            return (charset is null
                    ? Encoding.UTF8
                    : Encoding.GetEncoding(charset)).GetString(bytes);
        }
        catch
        {
            return Convert.ToBase64String(bytes);
        }
    }

    private static string HttpStatusCodeToText(HttpStatusCode code) => code.ToString();
}
