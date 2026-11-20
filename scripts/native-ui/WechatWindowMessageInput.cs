// Targeted client messages do not move the system pointer. Queue acceptance is
// not a click/submit acknowledgment; each caller must confirm its own outcome.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

internal static partial class WechatDraftProbe {
    [DllImport("user32.dll",EntryPoint="PostMessageW",SetLastError=true)]static extern bool WindowMessagePost(IntPtr window,uint message,UIntPtr flags,IntPtr position);
    static IntPtr WindowMessageCoordinates(Point point){Need(point.X>=0&&point.X<=32767&&point.Y>=0&&point.Y<=32767,"UIA_POINTER_COORDINATES_INVALID");return new IntPtr(unchecked((int)((uint)point.X|((uint)point.Y<<16))));}
    static int WindowMessageClickCore(Point point,Func<uint,UIntPtr,IntPtr,bool> post,Action beforeDown,Func<bool> releaseTargetSame,Action markAttempted){
        IntPtr coordinates=WindowMessageCoordinates(point);int posted=0;bool down=false;
        Action<uint> send=delegate(uint message){markAttempted();Need(post(message,new UIntPtr(message==0x201?1u:0u),coordinates),"UIA_POINTER_QUEUE_REJECTED");posted++;if(message==0x201)down=true;if(message==0x202)down=false;};
        try{
            send(0x200);beforeDown();
            // Once down is queued, pair it once on the identical recipient,
            // even if the activity/focus guard would refuse a new gesture.
            // A failed up is uncertain and is never queued a second time.
            try{send(0x201);}finally{if(down){Need(releaseTargetSame(),"UIA_POINTER_RELEASE_TARGET_CHANGED");send(0x202);}}
            return posted;
        }catch(Exception error){error.Data["WindowMessageInput"]=Data("messagesPosted",posted,"unpairedDownQueued",down,"retryAllowed",false);throw;}
    }
    static int WindowMessageClick(IntPtr window,Point point,Action beforeDown,Func<bool> releaseTargetSame,Action markAttempted){
        Need(window!=IntPtr.Zero&&window!=new IntPtr(0xffff),"UIA_POINTER_TARGET_INVALID");
        return WindowMessageClickCore(point,delegate(uint message,UIntPtr flags,IntPtr coordinates){return WindowMessagePost(window,message,flags,coordinates);},beforeDown,releaseTargetSame,markAttempted);
    }
    static int WindowMessageInputSelfTest(){int n=0;
        Need(WindowMessageCoordinates(new Point(12,34)).ToInt64()==((34L<<16)|12)&&WindowMessageCoordinates(new Point(32767,32767)).ToInt64()==0x7fff7fff,"UIA_POINTER_TEST_CLIENT_COORDINATES");n++;
        foreach(Point invalid in new[]{new Point(-1,0),new Point(0,-1),new Point(32768,0),new Point(0,32768)}){Expect(delegate{WindowMessageCoordinates(invalid);},"UIA_POINTER_COORDINATES_INVALID");n++;}
        var messages=new List<uint>();int guards=0,marks=0;int count=WindowMessageClickCore(new Point(12,34),delegate(uint message,UIntPtr flags,IntPtr coordinates){Need(coordinates.ToInt64()==((34L<<16)|12)&&flags.ToUInt64()==(message==0x201?1ul:0ul),"UIA_POINTER_TEST_FLAGS");messages.Add(message);return true;},delegate{guards++;},delegate{return true;},delegate{marks++;});
        Need(count==3&&marks==3&&guards==1&&messages.Count==3&&messages[0]==0x200&&messages[1]==0x201&&messages[2]==0x202,"UIA_POINTER_TEST_SINGLE_SEQUENCE");n++;
        for(int failure=0;failure<3;failure++){int index=0,stop=failure;messages.Clear();try{WindowMessageClickCore(new Point(1,2),delegate(uint message,UIntPtr flags,IntPtr position){messages.Add(message);return index++!=stop;},delegate{},delegate{return true;},delegate{});throw new Exception("missing failure");}catch(Fault error){Need(error.Message=="UIA_POINTER_QUEUE_REJECTED"&&messages.Count==stop+1&&Number(Get(Map(error.Data["WindowMessageInput"]),"messagesPosted"))==stop&&Object.Equals(Get(Map(error.Data["WindowMessageInput"]),"unpairedDownQueued"),stop==2),"UIA_POINTER_TEST_NO_RETRY_ON_PARTIAL_QUEUE");}n++;}
        messages.Clear();Expect(delegate{WindowMessageClickCore(new Point(1,2),delegate(uint message,UIntPtr flags,IntPtr position){messages.Add(message);return true;},delegate{throw new Fault("UIA_POINTER_TEST_ACTIVITY_CHANGED");},delegate{return true;},delegate{});},"UIA_POINTER_TEST_ACTIVITY_CHANGED");Need(messages.Count==1,"UIA_POINTER_TEST_BEFORE_DOWN_NO_CLICK");n++;
        messages.Clear();Expect(delegate{WindowMessageClickCore(new Point(1,2),delegate(uint message,UIntPtr flags,IntPtr position){messages.Add(message);return true;},delegate{},delegate{return false;},delegate{});},"UIA_POINTER_RELEASE_TARGET_CHANGED");Need(messages.Count==2,"UIA_POINTER_TEST_REUSED_RECIPIENT_NOT_RELEASED");n++;
        return n;
    }
}
