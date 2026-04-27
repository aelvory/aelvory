# Production build for Aelvory.Server
# Build context should be the repo root:
#   docker build -f apps/server/Dockerfile -t aelvory-server .
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

COPY apps/server/Aelvory.Server.csproj apps/server/
RUN dotnet restore apps/server/Aelvory.Server.csproj

COPY apps/server/ apps/server/
RUN dotnet publish apps/server/Aelvory.Server.csproj \
    -c Release \
    -o /out \
    --no-restore \
    /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app

# curl is the only thing in the image that can do HTTP for the
# HEALTHCHECK below — the .NET aspnet runtime image is debian-slim and
# ships neither curl nor wget. Add it explicitly and clean caches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /out ./
ENV ASPNETCORE_URLS=http://0.0.0.0:8080
EXPOSE 8080

# `/healthz` runs every registered health check (currently: database
# reachability). Failing this marks the container unhealthy so
# `depends_on: condition: service_healthy` and external load balancers
# can take it out of rotation. start-period gives EF migrations + first
# DB connection time to come up before failures count toward retries.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl --silent --show-error --fail --max-time 4 \
        http://localhost:8080/healthz || exit 1

ENTRYPOINT ["dotnet", "Aelvory.Server.dll"]
