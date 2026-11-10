"""Numerical CPU reference checks. No model files, media, GPU or network needed."""
import sys,unittest
from pathlib import Path
sys.path.insert(0,str((Path.cwd() if __file__=="<stdin>" else Path(__file__).resolve().parents[1])/"ai"))
import torch
from neighborhood import qk1,av1,qk2,av2
def neighbors(position,length,kernel,dilation):
    candidates=list(range(position%dilation,length,dilation))
    center=candidates.index(position)
    begin=max(0,min(center-kernel//2,len(candidates)-kernel))
    return candidates[begin:begin+kernel]
class NeighborhoodReference(unittest.TestCase):
    def setUp(self):
        torch.manual_seed(7)
        torch.set_num_threads(1)
    def test_one_dimension(self):
        for length,kernel,dilation in [(7,3,1),(13,3,2),(15,5,3)]:
            q,k,v=[torch.randn(1,2,length,3,dtype=torch.float64) for _ in range(3)]
            bias=torch.randn(2,2*kernel-1,dtype=torch.float64)
            expected=torch.empty(1,2,length,kernel,dtype=torch.float64)
            for i in range(length):
                for j,target in enumerate(neighbors(i,length,kernel,dilation)):
                    expected[:,:,i,j]=(q[:,:,i]*k[:,:,target]).sum(-1)+bias[:,(target-i)//dilation+kernel-1]
            actual=qk1(q,k,bias,kernel,dilation);torch.testing.assert_close(actual,expected)
            attention=actual.softmax(-1);result=torch.zeros_like(v)
            for i in range(length):
                for j,target in enumerate(neighbors(i,length,kernel,dilation)):
                    result[:,:,i]+=attention[:,:,i,j,None]*v[:,:,target]
            torch.testing.assert_close(av1(attention,v,kernel,dilation),result)
    def test_two_dimensions(self):
        for height,width,kernel,dilation in [(7,8,3,1),(7,9,3,2)]:
            q,k,v=[torch.randn(1,2,height,width,3,dtype=torch.float64) for _ in range(3)]
            bias=torch.randn(2,2*kernel-1,2*kernel-1,dtype=torch.float64)
            expected=torch.empty(1,2,height,width,kernel*kernel,dtype=torch.float64)
            for y in range(height):
                for x in range(width):
                    for j,ty in enumerate(neighbors(y,height,kernel,dilation)):
                        for i,tx in enumerate(neighbors(x,width,kernel,dilation)):
                            expected[:,:,y,x,j*kernel+i]=(q[:,:,y,x]*k[:,:,ty,tx]).sum(-1)+bias[:,(ty-y)//dilation+kernel-1,(tx-x)//dilation+kernel-1]
            actual=qk2(q,k,bias,kernel,dilation);torch.testing.assert_close(actual,expected)
            attention=actual.softmax(-1);result=torch.zeros_like(v)
            for y in range(height):
                for x in range(width):
                    for j,ty in enumerate(neighbors(y,height,kernel,dilation)):
                        for i,tx in enumerate(neighbors(x,width,kernel,dilation)):
                            result[:,:,y,x]+=attention[:,:,y,x,j*kernel+i,None]*v[:,:,ty,tx]
            torch.testing.assert_close(av2(attention,v,kernel,dilation),result)
if __name__=="__main__":unittest.main()
