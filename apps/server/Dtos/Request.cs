using Aelvory.Server.Entities;

namespace Aelvory.Server.Dtos;

public record HeaderDto(string Key, string Value, bool Enabled);

public record RequestBodyDto(string Type, string? Raw, string? ContentType);

public record AuthConfigDto(string Type, Dictionary<string, object>? Config);

public record ApiRequestDto(
    Guid Id,
    Guid CollectionId,
    string Name,
    RequestKind Kind,
    string Method,
    string Url,
    List<HeaderDto> Headers,
    RequestBodyDto? Body,
    AuthConfigDto? Auth,
    int SortIndex,
    int Version,
    DateTime CreatedAt,
    DateTime UpdatedAt);

public record CreateRequestRequest(
    string Name,
    RequestKind Kind,
    string Method,
    string Url,
    List<HeaderDto>? Headers,
    RequestBodyDto? Body,
    AuthConfigDto? Auth,
    int? SortIndex);

public record UpdateRequestRequest(
    string Name,
    string Method,
    string Url,
    List<HeaderDto> Headers,
    RequestBodyDto? Body,
    AuthConfigDto? Auth);

public record MoveRequestRequest(Guid NewCollectionId, int NewSortIndex);

public record ScriptDto(Guid Id, Guid RequestId, ScriptPhase Phase, string Source);

public record UpsertScriptRequest(ScriptPhase Phase, string Source);
