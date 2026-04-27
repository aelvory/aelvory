using Aelvory.Server.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace Aelvory.Server.HealthChecks;

/// <summary>
/// Readiness probe for the Postgres connection. Hits
/// <see cref="DatabaseFacade.CanConnectAsync"/>, which executes
/// <c>SELECT 1</c> against an open connection (or opens one), and reports
/// the boolean back without throwing on transport failures.
///
/// We deliberately avoid the
/// <c>Microsoft.Extensions.Diagnostics.HealthChecks.EntityFrameworkCore</c>
/// package — that one calls <c>db.Database.CanConnect()</c> the same way
/// underneath but ships a transitive graph we don't need.
/// </summary>
public sealed class DatabaseHealthCheck(AelvoryDbContext db) : IHealthCheck
{
    public async Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context,
        CancellationToken cancellationToken = default)
    {
        try
        {
            var ok = await db.Database.CanConnectAsync(cancellationToken);
            return ok
                ? HealthCheckResult.Healthy("postgres reachable")
                : HealthCheckResult.Unhealthy("postgres unreachable");
        }
        catch (Exception ex)
        {
            return HealthCheckResult.Unhealthy("postgres error", ex);
        }
    }
}
