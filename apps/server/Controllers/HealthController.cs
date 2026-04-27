using Microsoft.AspNetCore.Mvc;

namespace Aelvory.Server.Controllers;

[ApiController]
[Route("api/[controller]")]
public class HealthController : ControllerBase
{
    [HttpGet]
    public IActionResult Get() => Ok(new { status = "ok", version = "0.0.1" });
}
