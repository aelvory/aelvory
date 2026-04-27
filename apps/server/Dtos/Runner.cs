namespace Aelvory.Server.Dtos;

public record ExecuteRequest(
    string Method,
    string Url,
    List<HeaderDto>? Headers,
    RequestBodyDto? Body,
    AuthConfigDto? Auth,
    int? TimeoutMs);

public record ExecuteResponse(
    int Status,
    string StatusText,
    List<HeaderDto> Headers,
    List<HeaderDto> RequestHeaders,
    string RequestUrl,
    string RequestMethod,
    string Body,
    long DurationMs,
    long SizeBytes,
    string? ContentType,
    string? ErrorMessage);
