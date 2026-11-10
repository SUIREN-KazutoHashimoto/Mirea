/* Local inference launcher. It cannot elevate privileges or relax an inherited
 * sandbox. Reject all outbound connect() calls, including runtime downloads.
 * The parent binds llama-server only to loopback with an ephemeral API key.
 * Media/model paths are passed by the validated parent, never shell-expanded.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#if defined(__x86_64__)
#define MIREA_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define MIREA_ARCH AUDIT_ARCH_AARCH64
#else
#error Unsupported inference launcher architecture
#endif
static void fail(void){fprintf(stderr,"AI_RUNTIME_UNAVAILABLE\n");exit(78);}
int main(int argc,char **argv){
    if(argc<2||argv[1][0]!='/')fail();
    if(prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0)||prctl(PR_GET_NO_NEW_PRIVS,0,0,0,0)!=1)fail();
    struct sock_filter instructions[]={
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,arch)),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,MIREA_ARCH,1,0),
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),
#ifdef __x86_64__
        /* x32 must not reinterpret an unfiltered syscall number. */
        BPF_JUMP(BPF_JMP|BPF_JSET|BPF_K,0x40000000,0,1),
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
#endif
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_connect,0,1),
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_sendmsg,0,1),
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_sendmmsg,0,1),
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        /* sendto with a null destination is also used for accepted HTTP sockets. */
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_sendto,0,6),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,args[4])),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,0,0,3),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,args[4])+4),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,0,0,1),
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW),
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW)
    };
    struct sock_fprog program={.len=(unsigned short)(sizeof(instructions)/sizeof(instructions[0])),.filter=instructions};
    if(prctl(PR_SET_SECCOMP,SECCOMP_MODE_FILTER,&program))fail();
    execv(argv[1],argv+1);fail();
}
