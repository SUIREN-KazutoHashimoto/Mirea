"""CPU neighborhood attention for the fixed All-In-One architecture.
This implements dilated sliding neighborhoods using PyTorch tensor operations.
No compiled NATTEN extension, CUDA, model downloads, or inference service is used.
"""
import torch
from functools import lru_cache

@lru_cache(maxsize=128)
def indices(length, kernel, dilation):
    position = torch.arange(length)
    residue = position.remainder(dilation)
    index = position.div(dilation, rounding_mode="floor")
    available = (length - 1 - residue).div(dilation, rounding_mode="floor") + 1
    start = torch.minimum(torch.maximum(index - kernel // 2, torch.zeros_like(index)), available - kernel)
    target = (start[:, None] + torch.arange(kernel)) * dilation + residue[:, None]
    bias = (target - position[:, None]).div(dilation, rounding_mode="floor") + kernel - 1
    return target, bias

def qk1(query, key, bias, kernel, dilation):
    target, relative = indices(query.shape[2], kernel, dilation)
    scores = []
    for j in range(kernel):
        scores.append((query * key[:, :, target[:, j], :]).sum(-1) + bias[:, relative[:, j]][None])
    return torch.stack(scores, -1)

def av1(attention, value, kernel, dilation):
    target, _ = indices(value.shape[2], kernel, dilation)
    result = torch.zeros_like(value)
    for j in range(kernel):
        result.add_(attention[..., j, None] * value[:, :, target[:, j], :])
    return result

def qk2(query, key, bias, kernel, dilation):
    height, width = query.shape[2:4]
    iy, by = indices(height, kernel, dilation)
    ix, bx = indices(width, kernel, dilation)
    scores = []
    for y in range(kernel):
        for x in range(kernel):
            neighbors = key[:, :, iy[:, y, None], ix[None, :, x], :]
            relative = bias[:, by[:, y, None], bx[None, :, x]][None]
            scores.append((query * neighbors).sum(-1) + relative)
    return torch.stack(scores, -1)

def av2(attention, value, kernel, dilation):
    height, width = value.shape[2:4]
    iy, _ = indices(height, kernel, dilation)
    ix, _ = indices(width, kernel, dilation)
    result = torch.zeros_like(value)
    for y in range(kernel):
        for x in range(kernel):
            result.add_(attention[..., y * kernel + x, None] * value[:, :, iy[:, y, None], ix[None, :, x], :])
    return result
