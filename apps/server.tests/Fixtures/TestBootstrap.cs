using System.Runtime.CompilerServices;

namespace Aelvory.Server.Tests.Fixtures;

/// <summary>
/// Runs once per test-assembly load, before any test executes.
/// Sets environment variables that <c>Program.cs</c> reads eagerly
/// (before <c>WebApplicationFactory.ConfigureAppConfiguration</c>
/// has had a chance to inject overrides). The Postgres connection
/// can't go here because each test class gets its own database
/// (resolved at fixture init time) — that's still pushed via
/// <c>AelvoryFactory.ConfigureWebHost</c>.
///
/// Why a ModuleInitializer instead of a fixture: the JWT signing
/// key is read at top-level-statement time in <c>Program.cs</c>,
/// which fires the moment WebApplicationFactory builds the host —
/// inside the fixture's InitializeAsync, but BEFORE the in-memory
/// configuration overrides we register in ConfigureWebHost are
/// visible. Setting the value as a process-wide env var is the only
/// way to reach the eager read; ModuleInitializer guarantees the
/// var is set before any factory code runs.
/// </summary>
internal static class TestBootstrap
{
    [ModuleInitializer]
    public static void Initialize()
    {
        // Test env runs with ASPNETCORE_ENVIRONMENT=Test, NOT Development,
        // so Program.cs's non-Dev startup check applies — which means
        // (a) we can't use the dev sentinel here (the check rejects it)
        // and (b) the key has to be ≥32 bytes. The value below is just
        // a long, unique random-looking string that isn't the dev
        // sentinel; it's fine for tests because nothing about token
        // forgery resistance matters when the only client is the test
        // suite itself.
        Environment.SetEnvironmentVariable(
            "Jwt__SigningKey",
            "test-signing-key-not-the-dev-sentinel-and-long-enough-for-hmac-sha256");
        Environment.SetEnvironmentVariable("Jwt__Issuer", "aelvory");
        Environment.SetEnvironmentVariable("Jwt__Audience", "aelvory-clients");
    }
}
