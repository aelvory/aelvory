namespace Aelvory.Server.Entities;

public enum RequestKind
{
    Http,
    WebSocket,
    ServerSentEvents,
    GraphQL
}

public class ApiRequest
{
    public Guid Id { get; set; }
    public Guid CollectionId { get; set; }
    public Collection Collection { get; set; } = null!;
    public required string Name { get; set; }
    public RequestKind Kind { get; set; }
    public string Method { get; set; } = "GET";
    public string Url { get; set; } = "";
    public string HeadersJson { get; set; } = "[]";
    public string? BodyJson { get; set; }
    public string? AuthJson { get; set; }
    public int SortIndex { get; set; }
    public List<Script> Scripts { get; set; } = [];
    public int Version { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
    public DateTime? DeletedAt { get; set; }
}
