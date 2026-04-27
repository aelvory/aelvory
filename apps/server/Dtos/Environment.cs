using Aelvory.Server.Entities;

namespace Aelvory.Server.Dtos;

public record EnvironmentDto(
    Guid Id,
    Guid ProjectId,
    string Name,
    int Version,
    DateTime CreatedAt,
    DateTime UpdatedAt);

public record CreateEnvironmentRequest(string Name);

public record UpdateEnvironmentRequest(string Name);

public record VariableDto(
    Guid Id,
    VariableScope Scope,
    Guid ScopeId,
    string Key,
    string? Value,
    bool IsSecret,
    string? Ciphertext,
    string? Nonce,
    Guid? KeyId,
    int Version);

public record UpsertVariableRequest(
    string Key,
    string? Value,
    bool IsSecret,
    string? Ciphertext,
    string? Nonce,
    Guid? KeyId);
