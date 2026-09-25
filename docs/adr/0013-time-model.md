# ADR-0013 · Attendance and allocations are separate

**Status:** proposed (S4). Clock in/out (`attendance_sessions`) records presence and is never gated. Allocations (`time_allocations`) say what the time was for; allocations to client projects are gated (INV-06). The weekly confirmation pre-fills allocations scaled to attendance.
