// JNI adapter for Kelma's portable C ABI.
// SPDX-License-Identifier: AGPL-3.0-or-later

use std::{ffi::CString, ptr, slice};

use jni::{
    objects::{JClass, JString},
    sys::{jlong, jstring},
    JNIEnv,
};

use super::{
    kelma_buffer_free, kelma_core_info, kelma_session_close, kelma_session_open, kelma_session_run,
    KelmaBuffer, KelmaResult, KelmaSession,
};

fn take_buffer(buffer: KelmaBuffer) -> Result<String, String> {
    let bytes = if buffer.data.is_null() {
        Vec::new()
    } else {
        // SAFETY: KelmaBuffer is allocated by the core and remains valid until
        // `kelma_buffer_free()` below.
        unsafe { slice::from_raw_parts(buffer.data, buffer.len).to_vec() }
    };
    // SAFETY: this function takes ownership of each returned buffer exactly once.
    unsafe { kelma_buffer_free(buffer) };
    String::from_utf8(bytes)
        .map_err(|error| format!("native core returned non-UTF-8 data: {error}"))
}

fn take_result(result: KelmaResult) -> Result<String, String> {
    let status = result.status;
    let message = take_buffer(result.payload)?;
    if status == 0 {
        Ok(message)
    } else if message.is_empty() {
        Err(format!("native core operation failed with status {status}"))
    } else {
        Err(message)
    }
}

fn java_input(env: &mut JNIEnv<'_>, value: &JString<'_>) -> Result<String, String> {
    env.get_string(value)
        .map(Into::into)
        .map_err(|error| format!("invalid Java string: {error}"))
}

fn java_output(env: &mut JNIEnv<'_>, value: String) -> Result<jstring, String> {
    env.new_string(value)
        .map(|string| string.into_raw())
        .map_err(|error| format!("unable to allocate Java string: {error}"))
}

fn throw(env: &mut JNIEnv<'_>, message: String) -> jstring {
    let _ = env.throw_new("java/lang/RuntimeException", message);
    ptr::null_mut()
}

#[no_mangle]
pub extern "system" fn Java_tech_kelma_mobile_core_KelmaCoreJni_coreInfo(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
) -> jstring {
    match take_result(kelma_core_info()).and_then(|value| java_output(&mut env, value)) {
        Ok(value) => value,
        Err(error) => throw(&mut env, error),
    }
}

#[no_mangle]
pub extern "system" fn Java_tech_kelma_mobile_core_KelmaCoreJni_open(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    request: JString<'_>,
) -> jlong {
    let request = match java_input(&mut env, &request) {
        Ok(value) => value,
        Err(error) => {
            throw(&mut env, error);
            return 0;
        }
    };

    // SAFETY: the request bytes remain alive for the duration of the call, and
    // the returned session is owned by Kotlin until `close()`.
    let result = unsafe { kelma_session_open(request.as_ptr(), request.len()) };
    if result.status == 0 && !result.handle.is_null() {
        // Success carries an empty error buffer, which still follows the normal
        // ownership contract.
        let _ = take_buffer(result.error);
        result.handle as jlong
    } else {
        let message = take_buffer(result.error)
            .unwrap_or_else(|error| error)
            .trim()
            .to_owned();
        throw(
            &mut env,
            if message.is_empty() {
                format!(
                    "unable to open native collection (status {})",
                    result.status
                )
            } else {
                message
            },
        );
        0
    }
}

#[no_mangle]
pub extern "system" fn Java_tech_kelma_mobile_core_KelmaCoreJni_run(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    handle: jlong,
    operation: JString<'_>,
    request: JString<'_>,
) -> jstring {
    if handle == 0 {
        return throw(&mut env, "native collection is not open".to_owned());
    }

    let operation = match java_input(&mut env, &operation) {
        Ok(value) => value,
        Err(error) => return throw(&mut env, error),
    };
    let operation = match CString::new(operation) {
        Ok(value) => value,
        Err(_) => return throw(&mut env, "operation name contains a NUL byte".to_owned()),
    };
    let request = match java_input(&mut env, &request) {
        Ok(value) => value,
        Err(error) => return throw(&mut env, error),
    };

    // SAFETY: Kotlin serializes access and owns `handle`; strings remain alive
    // for the duration of the call.
    let result = unsafe {
        kelma_session_run(
            handle as *mut KelmaSession,
            operation.as_ptr(),
            request.as_ptr(),
            request.len(),
        )
    };
    match take_result(result).and_then(|value| java_output(&mut env, value)) {
        Ok(value) => value,
        Err(error) => throw(&mut env, error),
    }
}

#[no_mangle]
pub extern "system" fn Java_tech_kelma_mobile_core_KelmaCoreJni_close(
    _env: JNIEnv<'_>,
    _class: JClass<'_>,
    handle: jlong,
) {
    if handle != 0 {
        // SAFETY: Kotlin calls close once for each non-zero handle it owns.
        unsafe { kelma_session_close(handle as *mut KelmaSession) };
    }
}
