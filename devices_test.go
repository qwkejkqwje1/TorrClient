package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const tvDesc = `<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device>
<friendlyName>[TV] Samsung</friendlyName><UDN>uuid:tv-1</UDN>
<serviceList><service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>/rc</controlURL></service>
<service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>upnp/control/AVTransport1</controlURL></service></serviceList>
</device></root>`

func TestParseRendererDesc(t *testing.T) {
	d, err := parseRendererDesc("http://192.168.1.50:9197/dmr", []byte(tvDesc))
	if err != nil {
		t.Fatal(err)
	}
	if d.Name != "[TV] Samsung" || d.control != "http://192.168.1.50:9197/upnp/control/AVTransport1" || d.ID != "dlna:uuid:tv-1" {
		t.Fatalf("%+v", d)
	}
	if ssdpLocation("HTTP/1.1 200 OK\r\nLOCATION: http://1.2.3.4:1/d.xml\r\nST: x\r\n") != "http://1.2.3.4:1/d.xml" {
		t.Fatal("location")
	}
	if hms(3725) != "1:02:05" {
		t.Fatal(hms(3725))
	}
}

func TestSoapCall(t *testing.T) {
	var got, action string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got, action = string(b), r.Header.Get("SOAPAction")
	}))
	defer srv.Close()
	d := &dlnaDevice{control: srv.URL, service: "urn:schemas-upnp-org:service:AVTransport:1"}
	if err := soapCall(d, "Seek", "<Unit>REL_TIME</Unit><Target>0:10:00</Target>"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "<u:Seek xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"><InstanceID>0</InstanceID><Unit>REL_TIME</Unit>") || action != `"urn:schemas-upnp-org:service:AVTransport:1#Seek"` {
		t.Fatalf("%s %s", action, got)
	}
}
