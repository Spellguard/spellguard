// NSM Attestation Document Generator (Go)
//
// Opens /dev/nsm, generates an attestation document with user-provided data,
// and outputs JSON with the COSE_Sign1 document and PCR values.
//
// This replaces the Rust nsm-attestation binary. The NSM protocol is
// CBOR-over-ioctl, which doesn't need a language-specific SDK.
//
// Usage: nsm-attestation --user-data <base64-encoded-data>
//
// Output (stdout):
//
//	{
//	  "attestationDocument": "<base64 COSE_Sign1>",
//	  "pcrs": { "0": "<hex>", "1": "<hex>", ... }
//	}
//
// Build: CGO_ENABLED=0 GOOS=linux go build -ldflags='-s -w' -o nsm-attestation .
package main

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"syscall"
	"unsafe"

	"github.com/fxamacker/cbor/v2"
)

const (
	nsmDevicePath = "/dev/nsm"
	// _IOWR(0x0A, 0, 32): ioctl command for the NSM device.
	// 0x0A = NSM magic, 0 = command number, 32 = sizeof(nsmMessage) on 64-bit.
	nsmIoctlCmd        = 0xC0200A00
	responseBufferSize = 16384
)

// nsmMessage matches the kernel's struct nsm_message (2 iov pairs, 32 bytes on 64-bit).
type nsmMessage struct {
	requestAddr  uintptr
	requestLen   uint64
	responseAddr uintptr
	responseLen  uint64
}

type output struct {
	AttestationDocument string            `json:"attestationDocument"`
	PCRs                map[string]string `json:"pcrs"`
}

func nsmProcessRequest(fd int, request []byte) ([]byte, error) {
	response := make([]byte, responseBufferSize)

	msg := nsmMessage{
		requestAddr:  uintptr(unsafe.Pointer(&request[0])),
		requestLen:   uint64(len(request)),
		responseAddr: uintptr(unsafe.Pointer(&response[0])),
		responseLen:  uint64(len(response)),
	}

	_, _, errno := syscall.Syscall(
		syscall.SYS_IOCTL,
		uintptr(fd),
		uintptr(nsmIoctlCmd),
		uintptr(unsafe.Pointer(&msg)),
	)
	if errno != 0 {
		return nil, fmt.Errorf("ioctl: %w", errno)
	}

	return response[:msg.responseLen], nil
}

func main() {
	// Parse --user-data argument
	var userData []byte
	for i, arg := range os.Args {
		if arg == "--user-data" && i+1 < len(os.Args) {
			var err error
			userData, err = base64.StdEncoding.DecodeString(os.Args[i+1])
			if err != nil {
				fmt.Fprintf(os.Stderr, "Invalid base64 for --user-data: %v\n", err)
				os.Exit(1)
			}
		}
	}

	// Open /dev/nsm
	fd, err := syscall.Open(nsmDevicePath, syscall.O_RDWR, 0)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to open %s: %v\nAre we inside a Nitro Enclave?\n", nsmDevicePath, err)
		os.Exit(1)
	}
	defer syscall.Close(fd)

	// Build attestation request (matches Rust serde CBOR format)
	var userDataVal interface{}
	if len(userData) > 0 {
		userDataVal = userData
	}

	attestReq := map[string]interface{}{
		"Attestation": map[string]interface{}{
			"user_data":  userDataVal,
			"nonce":      nil,
			"public_key": nil,
		},
	}

	reqBytes, err := cbor.Marshal(attestReq)
	if err != nil {
		fmt.Fprintf(os.Stderr, "CBOR encode error: %v\n", err)
		os.Exit(1)
	}

	respBytes, err := nsmProcessRequest(fd, reqBytes)
	if err != nil {
		fmt.Fprintf(os.Stderr, "NSM attestation request failed: %v\n", err)
		os.Exit(1)
	}

	// Decode CBOR response
	var resp map[interface{}]interface{}
	if err := cbor.Unmarshal(respBytes, &resp); err != nil {
		fmt.Fprintf(os.Stderr, "CBOR decode error: %v\n", err)
		os.Exit(1)
	}

	if errMsg, ok := resp["Error"]; ok {
		fmt.Fprintf(os.Stderr, "NSM error: %v\n", errMsg)
		os.Exit(1)
	}

	attestResp, ok := resp["Attestation"].(map[interface{}]interface{})
	if !ok {
		fmt.Fprintf(os.Stderr, "Unexpected NSM response format: %v\n", resp)
		os.Exit(1)
	}

	document, ok := attestResp["document"].([]byte)
	if !ok {
		fmt.Fprintf(os.Stderr, "No document in attestation response\n")
		os.Exit(1)
	}

	// Extract PCR values from the attestation document payload.
	// The document is COSE_Sign1, possibly wrapped in CBOR Tag 18:
	//   Tag(18, [protected, unprotected, payload, signature])
	// The payload (element [2]) is a CBOR byte string containing a map with "pcrs".
	pcrs := make(map[string]string)

	// Decode the COSE_Sign1 structure — handle Tag 18 wrapper
	var raw interface{}
	if err := cbor.Unmarshal(document, &raw); err != nil {
		fmt.Fprintf(os.Stderr, "COSE decode error: %v\n", err)
	} else {
		// Unwrap Tag 18 if present
		var coseArray []interface{}
		switch v := raw.(type) {
		case cbor.Tag:
			if arr, ok := v.Content.([]interface{}); ok {
				coseArray = arr
			}
		case []interface{}:
			coseArray = v
		}

		if len(coseArray) >= 3 {
			// Element [2] is the payload byte string
			if payloadBytes, ok := coseArray[2].([]byte); ok {
				var attestDoc map[interface{}]interface{}
				if err := cbor.Unmarshal(payloadBytes, &attestDoc); err == nil {
					if pcrRaw, ok := attestDoc["pcrs"]; ok {
						if pcrMap, ok := pcrRaw.(map[interface{}]interface{}); ok {
							for k, v := range pcrMap {
								var idx uint64
								switch kt := k.(type) {
								case uint64:
									idx = kt
								case int64:
									idx = uint64(kt)
								default:
									continue
								}
								if data, ok := v.([]byte); ok {
									nonZero := false
									for _, b := range data {
										if b != 0 {
											nonZero = true
											break
										}
									}
									if nonZero {
										pcrs[fmt.Sprintf("%d", idx)] = hex.EncodeToString(data)
									}
								}
							}
						} else {
							fmt.Fprintf(os.Stderr, "pcrs field unexpected type: %T\n", pcrRaw)
						}
					} else {
						fmt.Fprintf(os.Stderr, "no pcrs field in attestation doc, keys: %v\n", mapKeys(attestDoc))
					}
				} else {
					fmt.Fprintf(os.Stderr, "payload CBOR decode error: %v\n", err)
				}
			} else {
				fmt.Fprintf(os.Stderr, "COSE element [2] not bytes, got %T\n", coseArray[2])
			}
		} else {
			fmt.Fprintf(os.Stderr, "COSE array too short (%d elements), raw type: %T\n", len(coseArray), raw)
		}
	}

	// Fallback: if COSE parsing yielded no PCRs, try DescribePCR ioctl calls
	if len(pcrs) == 0 {
		fmt.Fprintf(os.Stderr, "COSE PCR extraction yielded 0 PCRs, trying DescribePCR fallback\n")
		for idx := uint16(0); idx < 16; idx++ {
			pcrReq := map[string]interface{}{
				"DescribePCR": map[string]interface{}{
					"index": idx,
				},
			}
			pcrReqBytes, _ := cbor.Marshal(pcrReq)
			pcrRespBytes, err := nsmProcessRequest(fd, pcrReqBytes)
			if err != nil {
				continue
			}
			var pcrResp map[interface{}]interface{}
			if err := cbor.Unmarshal(pcrRespBytes, &pcrResp); err != nil {
				continue
			}
			if desc, ok := pcrResp["DescribePCR"].(map[interface{}]interface{}); ok {
				if data, ok := desc["data"].([]byte); ok {
					nonZero := false
					for _, b := range data {
						if b != 0 {
							nonZero = true
							break
						}
					}
					if nonZero {
						pcrs[fmt.Sprintf("%d", idx)] = hex.EncodeToString(data)
					}
				}
			}
		}
	}

	out := output{
		AttestationDocument: base64.StdEncoding.EncodeToString(document),
		PCRs:                pcrs,
	}

	if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
		fmt.Fprintf(os.Stderr, "JSON encode error: %v\n", err)
		os.Exit(1)
	}
}

func mapKeys(m map[interface{}]interface{}) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, fmt.Sprintf("%v", k))
	}
	return keys
}
