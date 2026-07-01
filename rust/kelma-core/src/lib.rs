// Kelma's portable C ABI for Anki rslib.
// SPDX-License-Identifier: AGPL-3.0-or-later

mod session;

use std::{
    any::Any,
    ffi::CStr,
    os::raw::c_char,
    panic::{catch_unwind, AssertUnwindSafe},
    ptr,
    slice,
};

use anki::backend::{init_backend, Backend};
use anki_proto::backend::BackendInit;
use prost::Message;
use serde_json::{json, Value};

use crate::session::KelmaSession;


const ANKI_VERSION: &str = "25.09.2";
const ANKI_COMMIT: &str = "3890e12c9e48c028c3f12aa58cb64bd9f8895e30";
const BRIDGE_VERSION: &str = env!("CARGO_PKG_VERSION");

const STATUS_OK: i32 = 0;
const STATUS_BACKEND_ERROR: i32 = 1;
const STATUS_PANIC: i32 = 2;
const STATUS_INVALID_ARGUMENT: i32 = 3;

#[repr(C)]
pub struct KelmaBuffer {
    pub data: *mut u8,
    pub len: usize,
    pub capacity: usize,
}

impl KelmaBuffer {
    fn empty() -> Self {
        Self {
            data: ptr::null_mut(),
            len: 0,
            capacity: 0,
        }
    }

    fn from_vec(mut bytes: Vec<u8>) -> Self {
        let buffer = Self {
            data: bytes.as_mut_ptr(),
            len: bytes.len(),
            capacity: bytes.capacity(),
        };
        std::mem::forget(bytes);
        buffer
    }

    fn from_message(message: impl Into<String>) -> Self {
        Self::from_vec(message.into().into_bytes())
    }
}

#[repr(C)]
pub struct KelmaResult {
    pub status: i32,
    pub payload: KelmaBuffer,
}

impl KelmaResult {
    fn ok(payload: Vec<u8>) -> Self {
        Self {
            status: STATUS_OK,
            payload: KelmaBuffer::from_vec(payload),
        }
    }

    fn error(status: i32, payload: impl Into<String>) -> Self {
        Self {
            status,
            payload: KelmaBuffer::from_message(payload),
        }
    }
}

#[repr(C)]
pub struct KelmaOpenResult {
    pub status: i32,
    pub handle: *mut Backend,
    pub error: KelmaBuffer,
}

impl KelmaOpenResult {
    fn ok(backend: Backend) -> Self {
        Self {
            status: STATUS_OK,
            handle: Box::into_raw(Box::new(backend)),
            error: KelmaBuffer::empty(),
        }
    }

    fn error(status: i32, error: impl Into<String>) -> Self {
        Self {
            status,
            handle: ptr::null_mut(),
            error: KelmaBuffer::from_message(error),
        }
    }
}

unsafe fn input_bytes<'a>(data: *const u8, len: usize) -> Result<&'a [u8], &'static str> {
    if data.is_null() {
        if len == 0 {
            Ok(&[])
        } else {
            Err("input pointer is null")
        }
    } else {
        Ok(slice::from_raw_parts(data, len))
    }
}

fn panic_message(panic: Box<dyn Any + Send>) -> String {
    if let Some(message) = panic.downcast_ref::<&str>() {
        (*message).to_owned()
    } else if let Some(message) = panic.downcast_ref::<String>() {
        message.clone()
    } else {
        "Anki Rust core panicked".to_owned()
    }
}

#[no_mangle]
pub unsafe extern "C" fn kelma_backend_open(
    input: *const u8,
    input_len: usize,
) -> KelmaOpenResult {
    let input = match input_bytes(input, input_len) {
        Ok(input) => input,
        Err(error) => return KelmaOpenResult::error(STATUS_INVALID_ARGUMENT, error),
    };

    match catch_unwind(AssertUnwindSafe(|| init_backend(input))) {
        Ok(Ok(backend)) => KelmaOpenResult::ok(backend),
        Ok(Err(error)) => KelmaOpenResult::error(STATUS_BACKEND_ERROR, error),
        Err(panic) => KelmaOpenResult::error(STATUS_PANIC, panic_message(panic)),
    }
}

#[no_mangle]
pub unsafe extern "C" fn kelma_backend_run(
    handle: *mut Backend,
    service: u32,
    method: u32,
    input: *const u8,
    input_len: usize,
) -> KelmaResult {
    if handle.is_null() {
        return KelmaResult::error(STATUS_INVALID_ARGUMENT, "backend handle is null");
    }
    let input = match input_bytes(input, input_len) {
        Ok(input) => input,
        Err(error) => return KelmaResult::error(STATUS_INVALID_ARGUMENT, error),
    };

    match catch_unwind(AssertUnwindSafe(|| {
        (*handle).run_service_method(service, method, input)
    })) {
        Ok(Ok(output)) => KelmaResult::ok(output),
        Ok(Err(error)) => KelmaResult {
            status: STATUS_BACKEND_ERROR,
            payload: KelmaBuffer::from_vec(error),
        },
        Err(panic) => KelmaResult::error(STATUS_PANIC, panic_message(panic)),
    }
}

#[no_mangle]
pub unsafe extern "C" fn kelma_backend_close(handle: *mut Backend) {
    if !handle.is_null() {
        drop(Box::from_raw(handle));
    }
}

#[no_mangle]
pub unsafe extern "C" fn kelma_buffer_free(buffer: KelmaBuffer) {
    if !buffer.data.is_null() {
        drop(Vec::from_raw_parts(
            buffer.data,
            buffer.len,
            buffer.capacity,
        ));
    }
}

#[no_mangle]
pub extern "C" fn kelma_core_info() -> KelmaResult {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let init = BackendInit {
            preferred_langs: vec!["en".to_owned()],
            locale_folder_path: String::new(),
            server: false,
        };
        let backend = init_backend(&init.encode_to_vec())?;
        drop(backend);

        Ok::<_, String>(
            json!({
                "ankiVersion": ANKI_VERSION,
                "ankiCommit": ANKI_COMMIT,
                "bridgeVersion": BRIDGE_VERSION,
                "platform": "ios",
            })
            .to_string()
            .into_bytes(),
        )
    }));

    match result {
        Ok(Ok(payload)) => KelmaResult::ok(payload),
        Ok(Err(error)) => KelmaResult::error(STATUS_BACKEND_ERROR, error),
        Err(panic) => KelmaResult::error(STATUS_PANIC, panic_message(panic)),
    }
}

// ---------------------------------------------------------------------------
// High-level collection session (review / schedule / sync).
//
// These operations are coarse on purpose: each crosses the bridge once and is
// fully backed by rslib. The platform layer keeps the returned handle and
// dispatches operations by name with JSON in/out.
// ---------------------------------------------------------------------------

#[repr(C)]
pub struct KelmaSessionResult {
    pub status: i32,
    pub handle: *mut KelmaSession,
    pub error: KelmaBuffer,
}

impl KelmaSessionResult {
    fn ok(session: Box<KelmaSession>) -> Self {
        Self {
            status: STATUS_OK,
            handle: Box::into_raw(session),
            error: KelmaBuffer::empty(),
        }
    }

    fn error(status: i32, error: impl Into<String>) -> Self {
        Self {
            status,
            handle: ptr::null_mut(),
            error: KelmaBuffer::from_message(error),
        }
    }
}

/// Open/create a collection. `input` is the UTF-8 JSON request described by
/// `KelmaSession::open`.
#[no_mangle]
pub unsafe extern "C" fn kelma_session_open(
    input: *const u8,
    input_len: usize,
) -> KelmaSessionResult {
    let bytes = match input_bytes(input, input_len) {
        Ok(bytes) => bytes,
        Err(error) => return KelmaSessionResult::error(STATUS_INVALID_ARGUMENT, error),
    };

    let result = catch_unwind(AssertUnwindSafe(|| {
        let request: Value = serde_json::from_slice(bytes)
            .map_err(|e| format!("invalid open request JSON: {e}"))?;
        KelmaSession::open(&request)
    }));

    match result {
        Ok(Ok(session)) => KelmaSessionResult::ok(session),
        Ok(Err(error)) => KelmaSessionResult::error(STATUS_BACKEND_ERROR, error),
        Err(panic) => KelmaSessionResult::error(STATUS_PANIC, panic_message(panic)),
    }
}

/// Dispatch a named operation on the session. `op` is a NUL-terminated C
/// string; `input` is UTF-8 JSON. The payload is always UTF-8 JSON on success
/// and a UTF-8 message on error.
#[no_mangle]
pub unsafe extern "C" fn kelma_session_run(
    handle: *mut KelmaSession,
    op: *const c_char,
    input: *const u8,
    input_len: usize,
) -> KelmaResult {
    if handle.is_null() {
        return KelmaResult::error(STATUS_INVALID_ARGUMENT, "session handle is null");
    }
    if op.is_null() {
        return KelmaResult::error(STATUS_INVALID_ARGUMENT, "operation name is null");
    }

    let op = match CStr::from_ptr(op).to_str() {
        Ok(op) => op.to_owned(),
        Err(_) => return KelmaResult::error(STATUS_INVALID_ARGUMENT, "operation name is not UTF-8"),
    };
    let bytes = match input_bytes(input, input_len) {
        Ok(bytes) => bytes,
        Err(error) => return KelmaResult::error(STATUS_INVALID_ARGUMENT, error),
    };

    let session = &*handle;
    let result = catch_unwind(AssertUnwindSafe(|| dispatch_session(session, &op, bytes)));

    match result {
        Ok(Ok(json)) => KelmaResult::ok(json.into_bytes()),
        Ok(Err(error)) => KelmaResult::error(STATUS_BACKEND_ERROR, error),
        Err(panic) => KelmaResult::error(STATUS_PANIC, panic_message(panic)),
    }
}

fn dispatch_session(session: &KelmaSession, op: &str, input: &[u8]) -> Result<String, String> {
    let request: Value = if input.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(input).map_err(|e| format!("invalid request JSON: {e}"))?
    };

    let value = match op {
        "deckTree" => session.deck_tree()?,
        "mediaDir" => session.media_dir()?,
        "setDeck" => session.set_current_deck(&request)?,
        "nextCard" => session.next_card()?,
        "answerCard" => session.answer_card(&request)?,
        "stats" => session.stats()?,
        "deckOverview" => session.deck_overview(&request)?,
        "browseDeck" => session.browse_deck(&request)?,
        "cardDetail" => session.card_detail(&request)?,
        "pendingChanges" => session.pending_changes()?,
        "getSyncAuth" => session.get_sync_auth()?,
        "setSyncAuth" => session.set_sync_auth(&request)?,
        "clearSyncAuth" => session.clear_sync_auth()?,
        "syncDebug" => session.sync_debug()?,
        "syncLogin" => session.sync_login(&request)?,
        "syncCollection" => session.sync_collection(&request)?,
        "syncMedia" => session.sync_media(&request)?,
        "syncStatus" => session.sync_status()?,
        "fullSync" => session.full_sync(&request)?,
        other => return Err(format!("unknown session operation '{other}'")),
    };

    Ok(value.to_string())
}

#[no_mangle]
pub unsafe extern "C" fn kelma_session_close(handle: *mut KelmaSession) {
    if !handle.is_null() {
        drop(Box::from_raw(handle));
    }
}

#[cfg(test)]
mod tests {
    use super::*;


    #[test]
    fn initializes_the_real_anki_backend() {
        let result = kelma_core_info();
        assert_eq!(result.status, STATUS_OK);

        let payload =
            unsafe { slice::from_raw_parts(result.payload.data, result.payload.len).to_vec() };
        unsafe { kelma_buffer_free(result.payload) };
        let info: serde_json::Value = serde_json::from_slice(&payload).unwrap();

        assert_eq!(info["ankiVersion"], ANKI_VERSION);
        assert_eq!(info["ankiCommit"], ANKI_COMMIT);
    }
}
