/*
 * Kelma's portable C ABI for Anki rslib.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

#ifndef KELMA_CORE_H
#define KELMA_CORE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
  uint8_t *data;
  size_t len;
  size_t capacity;
} KelmaBuffer;

typedef struct {
  int32_t status;
  KelmaBuffer payload;
} KelmaResult;

typedef struct {
  int32_t status;
  void *handle;
  KelmaBuffer error;
} KelmaOpenResult;

typedef struct {
  int32_t status;
  void *handle;
  KelmaBuffer error;
} KelmaSessionResult;

#ifdef __cplusplus
extern "C" {
#endif

KelmaOpenResult kelma_backend_open(const uint8_t *input, size_t input_len);

KelmaResult kelma_backend_run(
    void *handle,
    uint32_t service,
    uint32_t method,
    const uint8_t *input,
    size_t input_len);

void kelma_backend_close(void *handle);
void kelma_buffer_free(KelmaBuffer buffer);
KelmaResult kelma_core_info(void);

/* High-level collection session: review / schedule / sync. All payloads are
 * UTF-8 JSON. `op` is a NUL-terminated operation name (e.g. "nextCard"). */
KelmaSessionResult kelma_session_open(const uint8_t *input, size_t input_len);

KelmaResult kelma_session_run(
    void *handle,
    const char *op,
    const uint8_t *input,
    size_t input_len);

void kelma_session_close(void *handle);


#ifdef __cplusplus
}
#endif

#endif
