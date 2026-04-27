using Testcontainers.PostgreSql;
using Xunit;

namespace Aelvory.Server.Tests.Fixtures;

/// <summary>
/// Single Postgres container shared by the entire test suite. Lifetime
/// is "from xUnit's first collection-fixture init to last DisposeAsync"
/// — measured in seconds (one image pull + start) instead of per-class
/// (a few seconds × N classes).
///
/// Each test class derives a unique database name from the shared
/// container (<see cref="AelvoryFactory"/> manages that), so tests stay
/// isolated despite sharing the container. Within a class we let the
/// API itself reset state — see <see cref="AelvoryFactory.ResetAsync"/>.
/// </summary>
public sealed class PostgresFixture : IAsyncLifetime
{
    private PostgreSqlContainer? _container;

    /// <summary>
    /// Connection string template against the running container, with
    /// <c>{DB}</c> placeholder for the database name. Callers
    /// (<see cref="AelvoryFactory"/>) substitute their per-class DB
    /// name in.
    /// </summary>
    public string ConnectionStringTemplate { get; private set; } = "";

    /// <summary>
    /// Connection string targeting the container's default
    /// administrative database (<c>postgres</c>) — used to
    /// <c>CREATE DATABASE</c> / <c>DROP DATABASE</c> for per-class
    /// isolation without spinning up a new container each time.
    /// </summary>
    public string AdminConnectionString { get; private set; } = "";

    public async Task InitializeAsync()
    {
        _container = new PostgreSqlBuilder()
            // Match the prod / dev image so we exercise the same
            // server version (collation, JSON behaviour, etc.).
            .WithImage("postgres:16-alpine")
            .WithUsername("aelvory")
            .WithPassword("aelvory_test")
            .WithDatabase("postgres")
            .Build();

        await _container.StartAsync();

        var hostPort = _container.GetMappedPublicPort(5432);
        var baseConn =
            $"Host=localhost;Port={hostPort};Username=aelvory;Password=aelvory_test;";
        AdminConnectionString = baseConn + "Database=postgres";
        ConnectionStringTemplate = baseConn + "Database={DB}";
    }

    public async Task DisposeAsync()
    {
        if (_container is not null)
        {
            await _container.DisposeAsync();
        }
    }
}

/// <summary>
/// xUnit collection definition that pins <see cref="PostgresFixture"/>
/// to a single shared instance. Test classes opt in by decorating
/// themselves with <c>[Collection("postgres")]</c>.
/// </summary>
[CollectionDefinition("postgres")]
public sealed class PostgresCollection : ICollectionFixture<PostgresFixture>;
